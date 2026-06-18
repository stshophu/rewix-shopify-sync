/**
 * fix_titles.cjs
 * ─────────────────────────────────────────────────────────────
 * Finds all RewixSync products and rewrites their titles using the
 * dictionary translator in translate.cjs:  Brand + Gender + Name + Color.
 *
 * Usage:
 *   node fix_titles.cjs          ← dry run
 *   node fix_titles.cjs --commit ← apply changes
 */

require('dotenv').config();

const { buildTitle } = require('./translate.cjs');

const SHOPIFY_STORE       = process.env.SHOPIFY_STORE;
const SHOPIFY_TOKEN       = process.env.SHOPIFY_TOKEN;
const REWIX_BASE_URL      = process.env.REWIX_BASE_URL;
const REWIX_API_KEY       = process.env.REWIX_API_KEY;
const REWIX_PASSWORD      = process.env.REWIX_PASSWORD;
const SHOPIFY_API_VERSION = '2024-01';

const DRY_RUN = !process.argv.includes('--commit');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log   = msg => console.log(`[${new Date().toISOString()}] ${msg}`);
const warn  = msg => console.warn(`[${new Date().toISOString()}] ⚠  ${msg}`);

const base    = () => `https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}`;
const headers = () => ({
  'Content-Type':           'application/json',
  'X-Shopify-Access-Token': SHOPIFY_TOKEN,
});
const basicAuth = () => Buffer.from(`${REWIX_API_KEY}:${REWIX_PASSWORD}`).toString('base64');

const tagValue    = (tags, name) => tags?.find(t => t.name === name)?.value?.value || '';
const tagValueEN  = (tags, name) => tags?.find(t => t.name === name)?.value?.localeValues?.en_US?.value || tagValue(tags, name) || '';

// ─── RESILIENT FETCH ───────────────────────────────────────────────────────────
// Retries on dropped connections / timeouts / 429 / 5xx with exponential backoff.
// Returns the Response object (caller still checks res.ok for 4xx logic) but will
// itself retry 429/5xx. Throws only after all attempts are exhausted.

async function fetchRetry(url, options = {}, { attempts = 5, baseDelay = 1000, label = 'request' } = {}) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(url, options);
      // Retry transient server-side / rate-limit statuses
      if (res.status === 429 || res.status >= 500) {
        const retryAfter = Number(res.headers.get('Retry-After')) || 0;
        const delay = retryAfter * 1000 || baseDelay * 2 ** (i - 1);
        warn(`${label}: HTTP ${res.status} (attempt ${i}/${attempts}) — retrying in ${Math.round(delay)}ms`);
        await sleep(delay);
        continue;
      }
      return res;
    } catch (err) {
      // Network-level failure (ECONNRESET, fetch failed, timeout, etc.)
      lastErr = err;
      const delay = baseDelay * 2 ** (i - 1);
      warn(`${label}: ${err.message} (attempt ${i}/${attempts}) — retrying in ${Math.round(delay)}ms`);
      await sleep(delay);
    }
  }
  throw new Error(`${label}: failed after ${attempts} attempts — ${lastErr?.message || 'unknown error'}`);
}

// ─── FETCH REWIX CATALOG ───────────────────────────────────────────────────────

async function fetchRewixCatalog() {
  log('Fetching Rewix catalog...');
  const res = await fetchRetry(
    `${REWIX_BASE_URL}/restful/export/api/products.json?v=TEAL&acceptedlocales=en_US,de_DE`,
    { headers: { Authorization: `Basic ${basicAuth()}` } },
    { label: 'Rewix catalog' }
  );
  if (!res.ok) throw new Error(`Rewix error: ${res.status}`);
  const data = await res.json();
  log(`Rewix returned ${data.pageItems?.length ?? 0} products`);

  const skuToRewix     = new Map();
  const modelIdToRewix = new Map();

  for (const p of data.pageItems || []) {
    const brand  = tagValueEN(p.tags, 'brand');
    const color  = tagValueEN(p.tags, 'color');
    const subcat = tagValueEN(p.tags, 'subcategory');
    const gender = tagValueEN(p.tags, 'gender');
    const newTitle = buildTitle({ brand, gender, name: p.name, color, subcat });
    for (const m of p.models || []) {
      skuToRewix.set(m.code, { brand, color, subcat, newTitle });
      modelIdToRewix.set(m.id, { brand, color, subcat, newTitle });
    }
  }

  return { skuToRewix, modelIdToRewix };
}

// ─── FETCH SHOPIFY REWIXSYNC PRODUCTS ─────────────────────────────────────────

async function fetchShopifyProducts() {
  log('Fetching Shopify RewixSync products...');
  const products = [];
  let url = `${base()}/products.json?limit=250&fields=id,title,vendor,variants,tags`;
  let page = 0;
  while (url) {
    const res = await fetchRetry(url, { headers: headers() }, { label: `Shopify products page ${++page}` });
    if (!res.ok) throw new Error(`Shopify error: ${res.status}`);
    const data = await res.json();
    for (const p of data.products || []) {
      const tags = (p.tags || '').split(',').map(t => t.trim().toLowerCase());
      if (tags.includes('rewixsync')) products.push(p);
    }
    const link = res.headers.get('Link') || '';
    const next = link.match(/<([^>]+)>;\s*rel="next"/)?.[1];
    url = next || null;
    if (url) await sleep(600);
  }
  log(`Found ${products.length} RewixSync products`);
  return products;
}

// ─── MAIN ──────────────────────────────────────────────────────────────────────

async function run() {
  if (DRY_RUN) {
    log('🔍  DRY RUN — no changes. Pass --commit to apply.');
  } else {
    log('🚀  COMMIT mode — titles will be updated.');
  }

  const { skuToRewix, modelIdToRewix } = await fetchRewixCatalog();
  const products = await fetchShopifyProducts();

  const toUpdate = [];

  for (const p of products) {
    const currentTitle = p.title || '';

    let rewixData = null;
    for (const v of p.variants || []) {
      if (!v.sku) continue;
      if (skuToRewix.has(v.sku)) { rewixData = skuToRewix.get(v.sku); break; }
      const match = v.sku.match(/^REWIXSYNCRM-(\d+)$/i);
      if (match) {
        const modelId = parseInt(match[1], 10);
        if (modelIdToRewix.has(modelId)) { rewixData = modelIdToRewix.get(modelId); break; }
      }
    }

    if (!rewixData || !rewixData.brand) continue;
    if (!rewixData.newTitle) continue;

    // Skip products whose title is already correct — avoids needless writes
    if (currentTitle === rewixData.newTitle) continue;

    toUpdate.push({
      productId: p.id,
      oldTitle:  currentTitle,
      newTitle:  rewixData.newTitle,
      brand:     rewixData.brand,
    });
  }

  log(`\n--- SUMMARY ---`);
  log(`Products needing a title update: ${toUpdate.length}`);
  log(`Already correct / skipped:       ${products.length - toUpdate.length}`);

  if (DRY_RUN) {
    log('\nFirst 30 titles that would be updated:');
    toUpdate.slice(0, 30).forEach(p => log(`  "${p.oldTitle}" → "${p.newTitle}"`));
    log('\nRun with --commit to apply.');
    return;
  }

  let done = 0, errors = 0, failedIds = [];
  for (const p of toUpdate) {
    try {
      const res = await fetchRetry(
        `${base()}/products/${p.productId}.json`,
        {
          method: 'PUT', headers: headers(),
          body: JSON.stringify({ product: { id: p.productId, title: p.newTitle } }),
        },
        { label: `PUT ${p.productId}` }
      );
      if (res.ok) {
        log(`  ✅ "${p.oldTitle}" → "${p.newTitle}"`);
        done++;
      } else {
        warn(`  Failed (${p.productId}): ${res.status}`);
        errors++; failedIds.push(p.productId);
      }
    } catch (err) {
      // Even after retries this one product failed — log and keep going,
      // do NOT abort the whole run.
      warn(`  Failed (${p.productId}) after retries: ${err.message}`);
      errors++; failedIds.push(p.productId);
    }
    await sleep(500);
  }

  log(`\n✅  Done. Updated: ${done}, Errors: ${errors}`);
  if (failedIds.length) {
    log(`Products that still failed (re-run to retry): ${failedIds.join(', ')}`);
  }
}

run().catch(err => {
  console.error('\n❌  Fatal error:', err.message);
  process.exit(1);
});
