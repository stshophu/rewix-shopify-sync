/**
 * Rewix → Shopify Product Sync
 * ─────────────────────────────────────────────────────────────
 * • Fetches products from the Rewix API
 * • Creates / updates products in Shopify
 * • Titles built from a validated IT→EN dictionary translator
 * • Incremental sync — only changed products after the first run
 *
 * Usage:
 *   node sync.js          ← smart sync (full first time, incremental after)
 *   node sync.js --full   ← force a full catalog re-download
 */

require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const { buildTitle } = require('./translate.cjs');

// ─── CONFIG ────────────────────────────────────────────────────────────────────

const REWIX_BASE_URL   = process.env.REWIX_BASE_URL;
const REWIX_API_KEY    = process.env.REWIX_API_KEY;
const REWIX_PASSWORD   = process.env.REWIX_PASSWORD;
const REWIX_IMAGE_BASE = process.env.REWIX_IMAGE_BASE || REWIX_BASE_URL;

const SHOPIFY_STORE    = process.env.SHOPIFY_STORE;
const SHOPIFY_TOKEN    = process.env.SHOPIFY_TOKEN;

const LOCALES             = 'en_US,de_DE';
const LAST_UPDATE_FILE    = path.join(__dirname, '.last_sync_timestamp');
const SHOPIFY_API_VERSION = '2024-01';

// Delays to stay within API rate limits
const SHOPIFY_DELAY   = 600;  // ms between Shopify calls (~100/min)

// ─── HELPERS ───────────────────────────────────────────────────────────────────

const log  = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);
const warn = (msg) => console.warn(`[${new Date().toISOString()}] ⚠  ${msg}`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const basicAuth = () => Buffer.from(`${REWIX_API_KEY}:${REWIX_PASSWORD}`).toString('base64');

/**
 * fetch() wrapper that retries transient failures ("fetch failed" socket
 * resets, TLS blips, 429s, and 5xx) with exponential backoff. 4xx responses
 * are returned as-is so the caller can handle them.
 */
async function fetchWithRetry(url, opts = {}, { attempts = 4, label = 'request' } = {}) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(120_000) });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (err) {
      lastErr = err;
      if (i === attempts) break;
      const wait = Math.min(2 ** i * 1000, 30_000); // 2s, 4s, 8s, …
      warn(`${label} failed (attempt ${i}/${attempts}): ${err.message} — retrying in ${wait}ms`);
      await sleep(wait);
    }
  }
  throw lastErr;
}

// ─── REWIX API ──────────────────────────────────────────────────────────────────

async function fetchRewixProducts(since = null) {
  const params = new URLSearchParams({ v: 'TEAL', acceptedlocales: LOCALES });
if (since) {
    const ageMs = Date.now() - new Date(since).getTime();
    if (ageMs > 3.5 * 60 * 60 * 1000) {
      log('Saved timestamp older than Rewix 4h incremental window - falling back to full sync.');
      since = null;
    } else {
      params.set('since', since);
    }
  }

  const url = `${REWIX_BASE_URL}/restful/export/api/products.json?${params}`;
  log(`Fetching Rewix catalog${since ? ` (changes since ${since})` : ' (full)'}…`);

  const res = await fetchWithRetry(url, {
    headers: {
      Authorization: `Basic ${basicAuth()}`,
      Accept:        'application/json',
    },
  }, { label: 'Rewix catalog fetch' });

  if (!res.ok) throw new Error(`Rewix API error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  log(`Rewix returned ${data.pageItems?.length ?? 0} products (lastUpdate: ${data.lastUpdate})`);
  return data;
}

// ─── DATA HELPERS ──────────────────────────────────────────────────────────────

function localized(localizations, field) {
  if (!localizations) return '';
  const obj = localizations[field];
  if (!obj) return '';
  if (obj['en_US']?.value) return obj['en_US'].value;
  const first = Object.values(obj).find(v => v?.value);
  return first?.value || '';
}

function tagValue(tags, tagName) {
  return tags?.find(t => t.name === tagName)?.value?.value || '';
}

// English-locale tag reader. fix_titles.cjs established that Rewix tags carry
// localized values (brand/gender/color/subcategory) — tagValue() above only
// reads the raw Italian value, which is why titles built from it were wrong.
// Falls back to tagValue() when no en_US value exists, so it's always safe to
// use in place of tagValue().
function tagValueEN(tags, tagName) {
  const tag = tags?.find(t => t.name === tagName);
  return tag?.value?.localeValues?.en_US?.value || tagValue(tags, tagName) || '';
}

// ─── PRICING (25% margin, rewix_repricer.py formula) ───────────────────────
// price = (cost + shipping) * VAT / (1 - margin), rounded to .99, capped at
// the feed's streetPrice (RRP). Cost comes straight from the Rewix feed
// (m.taxable / m.bestTaxable) — present on 100% of models per the feed
// diagnostic — so pricing no longer depends on Shopify inventory_item.cost
// ever having been populated.
const PRICING_SHIPPING = 15.0;
const PRICING_VAT      = 1.19;
const PRICING_MARGIN   = 0.25;
const PRICING_DIVISOR  = 1 - PRICING_MARGIN; // 0.75

function roundTo99(price) {
  if (price <= 0) return 0;
  const floor = Math.floor(price);
  const candidate = floor + 0.99;
  return Math.abs(price - candidate) < 1e-9 ? price : candidate;
}

/**
 * Computes the resale price for one Rewix model.
 * Returns { price, compareAt, reviewReason } where reviewReason is one of:
 *   null            — priced normally, no issue
 *   'no-cost'        — feed has no usable cost for this model; can't safely price it
 *   'unprofitable'   — even at full RRP, the formula can't clear the target margin
 * Callers must draft the product and tag it accordingly rather than publish a guess.
 */
function computeVariantPricing(m) {
  const costRaw  = m.taxable ?? m.bestTaxable;
  const cost     = (costRaw !== undefined && costRaw !== null && costRaw !== '') ? parseFloat(costRaw) : NaN;
  const hasCost  = Number.isFinite(cost) && cost > 0;

  const streetRaw   = m.streetPrice;
  const streetPrice = (streetRaw !== undefined && streetRaw !== null && streetRaw !== '') ? parseFloat(streetRaw) : null;

  let price = null;
  let reviewReason = null;

  if (hasCost) {
    const minViable = (cost + PRICING_SHIPPING) * PRICING_VAT / PRICING_DIVISOR;
    let computed = roundTo99(minViable);
    if (streetPrice && streetPrice > 0 && computed > streetPrice) {
      computed = streetPrice; // never price above RRP
    }
    if (computed > 0) {
      price = computed;
      // Even capped at RRP, this must still clear (near enough) the target
      // margin — matches rewix_repricer.py's profitability check. A product
      // capped well below min_viable would otherwise sell silently at a loss.
      if (computed < minViable - 0.01) reviewReason = 'unprofitable';
    } else {
      reviewReason = 'unprofitable';
    }
  } else {
    reviewReason = 'no-cost'; // no real cost in the feed for this model
  }

  // Shopify still needs a non-negative price even on a flagged product, so the
  // payload doesn't fail to create/update. Best-effort fallback only — the
  // draft status + tag is what actually protects against selling at a bad price.
  if (price === null) {
    price = streetPrice && streetPrice > 0
      ? streetPrice
      : (m.suggestedPrice != null ? (parseFloat(m.suggestedPrice) || 0) : 0);
  }

  return { price, compareAt: streetPrice, reviewReason };
}

// ─── REWIX → SHOPIFY MAPPING ───────────────────────────────────────────────────

/**
 * Build a Shopify product payload from a Rewix product.
 */
function buildShopifyPayload(rp) {
  const brand       = tagValueEN(rp.tags, 'brand')       || '';
  const category    = tagValueEN(rp.tags, 'category')    || '';
  const gender      = tagValueEN(rp.tags, 'gender')      || '';
  const season      = tagValueEN(rp.tags, 'season')      || '';
  const color       = tagValueEN(rp.tags, 'color')       || '';
  const subcategory = tagValueEN(rp.tags, 'subcategory') || '';

  // ── Title ─────────────────────────────────────────────────────
  // Always built by the validated dictionary translator (translate.cjs) —
  // this is the fix_titles.cjs logic, applied at import time so products
  // are born correct instead of needing a backfill.
  const title = buildTitle({ brand, gender, name: rp.name, color, subcat: subcategory })
             || localized(rp.productLocalizations, 'productName')
             || rp.name;

  const bodyHtml = localized(rp.productLocalizations, 'description') || '';

  // ── Images ────────────────────────────────────────────────────
  const images = (rp.images || []).map(img => ({
    src: img.url.startsWith('http') ? img.url : `${REWIX_IMAGE_BASE}${img.url}`,
  }));

  // ── Variants & pricing ───────────────────────────────────────────
  // 25%-margin formula sourced straight from the feed's own cost
  // (m.taxable / m.bestTaxable). Any model we can't safely/profitably price
  // sets a review flag, which drafts the whole product below.
  let hasNoCost     = false;
  let hasUnprofitable = false;

  const variants = (rp.models || []).map(m => {
    const { price, compareAt, reviewReason } = computeVariantPricing(m);
    if (reviewReason === 'no-cost') hasNoCost = true;
    if (reviewReason === 'unprofitable') hasUnprofitable = true;

    return {
      sku:                  m.code,
      price:                price.toFixed(2),
      compare_at_price:     compareAt ? compareAt.toFixed(2) : undefined,
      barcode:              m.barcode || undefined,
      option1:              m.modelLocalizations?.color?.['en_US']?.value || m.color || 'Default',
      option2:              m.modelLocalizations?.size?.['en_US']?.value  || m.size  || undefined,
      inventory_management: 'shopify',
      inventory_quantity:   m.availability ?? 0,
      weight:               rp.weight ? parseFloat(rp.weight) : undefined,
      weight_unit:          rp.weight ? 'kg' : undefined,
      fulfillment_service:  'manual',
    };
  });

  const needsReviewProduct = hasNoCost || hasUnprofitable;

  const options = [{ name: 'Color' }];
  if (variants.some(v => v.option2)) options.push({ name: 'Size' });

  // ── Tags ──────────────────────────────────────────────────────
  const baseTags  = [brand, category, gender, season, 'RewixSync'].filter(Boolean);
  if (hasNoCost)       baseTags.push('needs-price-review'); // feed gave us no cost to work from
  if (hasUnprofitable) baseTags.push('rewix-unprofitable');  // priced, but can't clear margin even at RRP
  const allTags   = [...new Set(baseTags)].join(', ');

  // ── Metafields ────────────────────────────────────────────────
  const metafields = [
    { namespace: 'rewix', key: 'product_code', value: rp.code,         type: 'single_line_text_field' },
    { namespace: 'rewix', key: 'product_id',   value: String(rp.id),   type: 'single_line_text_field' },
    rp.hs     && { namespace: 'rewix', key: 'hs_code', value: rp.hs,         type: 'single_line_text_field' },
    rp.madein && { namespace: 'rewix', key: 'made_in', value: rp.madein,     type: 'single_line_text_field' },
  ].filter(Boolean);

  return {
    product: {
      title,
      body_html:    bodyHtml,
      vendor:       brand,
      product_type: category,
      tags:         allTags,
      status:       (rp.online === false || needsReviewProduct) ? 'draft' : 'active',
      options,
      variants,
      images,
      metafields,
    },
  };
}

// ─── SHOPIFY API ───────────────────────────────────────────────────────────────

const shopifyBase    = () => `https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}`;
const shopifyHeaders = () => ({
  'Content-Type':           'application/json',
  'X-Shopify-Access-Token': SHOPIFY_TOKEN,
});

async function loadShopifyIndex() {
  log('Building Shopify product index (this may take a moment for large catalogs)…');

  // Two lookup maps:
  // 1. skuToProductId   — native Rewix SKU (e.g. "GD6423_36") → Shopify product id
  // 2. modelIdToData    — Rewix numeric model id (e.g. 20585) → { productId, variantId }
  //    Handles products imported by the RewixSync app whose SKUs look like "REWIXSYNCRM-20585"
  const skuToProductId = new Map();
  const modelIdToData  = new Map();

  let url = `${shopifyBase()}/products.json?limit=250&fields=id,variants`;
  while (url) {
    const res = await fetch(url, { headers: shopifyHeaders() });
    if (!res.ok) throw new Error(`Shopify index error: ${res.status}`);
    const data = await res.json();
    for (const p of data.products || []) {
      for (const v of p.variants || []) {
        if (!v.sku) continue;
        // Native Rewix SKU index
        skuToProductId.set(v.sku, p.id);
        // RewixSync app SKU format: "REWIXSYNCRM-{modelId}"
        const match = v.sku.match(/^REWIXSYNCRM-(\d+)$/i);
        if (match) {
          modelIdToData.set(parseInt(match[1], 10), { productId: p.id, variantId: v.id });
        }
      }
    }
    const link = res.headers.get('Link') || '';
    const next = link.match(/<([^>]+)>;\s*rel="next"/)?.[1];
    url = next || null;
    if (url) await sleep(SHOPIFY_DELAY);
  }

  const rewixSyncCount = modelIdToData.size;
  const nativeCount    = skuToProductId.size - rewixSyncCount;
  log(`Shopify index built: ${skuToProductId.size} variants found (${rewixSyncCount} from RewixSync app, ${nativeCount} native).`);
  return { skuToProductId, modelIdToData };
}

async function createShopifyProduct(payload) {
  const res = await fetch(`${shopifyBase()}/products.json`, {
    method: 'POST', headers: shopifyHeaders(), body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    warn(`Create failed: ${JSON.stringify(err.errors || err)}`);
    return null;
  }
  return (await res.json()).product;
}

async function updateShopifyProduct(productId, payload) {
  // On updates we only refresh core fields + inventory, not images (avoids duplicates)
  const { images, metafields, ...rest } = payload.product;
  const res = await fetch(`${shopifyBase()}/products/${productId}.json`, {
    method: 'PUT', headers: shopifyHeaders(),
    body: JSON.stringify({ product: rest }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    warn(`Update failed (${productId}): ${JSON.stringify(err.errors || err)}`);
  }
}

async function updateVariantInventory(variantId, quantity) {
  const vRes = await fetch(`${shopifyBase()}/variants/${variantId}.json`, { headers: shopifyHeaders() });
  if (!vRes.ok) return;
  const { variant } = await vRes.json();

  const locRes = await fetch(`${shopifyBase()}/locations.json`, { headers: shopifyHeaders() });
  const { locations } = await locRes.json();
  // Target the "3169 Warehouse" location specifically
  const location = locations?.find(l => l.name === '3169 Warehouse') || locations?.[0];
  const locationId = location?.id;
  if (!locationId) {
    warn(`Location "3169 Warehouse" not found — skipping inventory update for variant ${variantId}`);
    return;
  }

  await fetch(`${shopifyBase()}/inventory_levels/set.json`, {
    method: 'POST', headers: shopifyHeaders(),
    body: JSON.stringify({
      inventory_item_id: variant.inventory_item_id,
      location_id:       locationId,
      available:         quantity,
    }),
  });
}

// ─── MAIN ──────────────────────────────────────────────────────────────────────

async function run() {
  const forceFullSync = process.argv.includes('--full');

  // Validate env vars
  const required = ['REWIX_BASE_URL','REWIX_API_KEY','REWIX_PASSWORD','SHOPIFY_STORE','SHOPIFY_TOKEN'];
  const missing  = required.filter(k => !process.env[k]);
  if (missing.length) {
    console.error(`❌  Missing environment variables: ${missing.join(', ')}`);
    console.error('    Fill in your .env file and try again.');
    process.exit(1);
  }

  // Determine sync mode
  let since = null;
  if (!forceFullSync && fs.existsSync(LAST_UPDATE_FILE)) {
    since = fs.readFileSync(LAST_UPDATE_FILE, 'utf8').trim();
    log(`Incremental sync from ${since}`);
  } else {
    log('Full catalog sync');
  }

  // Cursor for the NEXT incremental run. Anchor it to wall-clock time (minus a
  // small overlap) — NOT to rewixData.lastUpdate. The catalog's lastUpdate only
  // moves when products actually change, so during any quiet period >3.5h every
  // run would age out of the incremental window and fall back to a full sync
  // forever. Wall-clock anchoring advances the cursor every run and self-heals.
  const OVERLAP_MS = 15 * 60 * 1000; // 15-min look-back so mid-run edits aren't missed
  const syncCursor = new Date(Date.now() - OVERLAP_MS).toISOString();

  // Fetch from Rewix
  const rewixData = await fetchRewixProducts(since);
  const products  = rewixData.pageItems || [];

  if (products.length === 0) {
    log('No products to sync. Already up to date!');
    fs.writeFileSync(LAST_UPDATE_FILE, syncCursor);
    return;
  }

  // Build Shopify index (to detect new vs existing)
  const { skuToProductId, modelIdToData } = await loadShopifyIndex();

  let created = 0, updated = 0, skipped = 0, failed = 0;

  for (let i = 0; i < products.length; i++) {
    const rp         = products[i];
    const firstModel = rp.models?.[0];

    // Match strategy 1: native Rewix SKU (e.g. "GD6423_36")
    let existingId = firstModel?.code ? skuToProductId.get(firstModel.code) : null;

    // Match strategy 2: RewixSync app format "REWIXSYNCRM-{modelId}"
    if (!existingId && firstModel?.id) {
      existingId = modelIdToData.get(firstModel.id)?.productId || null;
      if (existingId) log(`  🔗 Matched via RewixSync model ID ${firstModel.id} → Shopify product ${existingId}`);
    }

    const isNew = !existingId;

    try {
      const payload = buildShopifyPayload(rp);

      if (isNew) {
        const newProduct = await createShopifyProduct(payload);
        if (newProduct) {
          for (const v of newProduct.variants || []) {
            if (v.sku) skuToProductId.set(v.sku, newProduct.id);
          }
          created++;
        } else {
          failed++;
        }
      } else {
        // Existing product — update title/price/tags/status and inventory
        await updateShopifyProduct(existingId, payload);
        for (const m of rp.models || []) {
          // Try native SKU first, then RewixSync model ID
          const vid = skuToProductId.get(m.code)
                   || modelIdToData.get(m.id)?.variantId;
          if (vid) {
            await updateVariantInventory(vid, m.availability ?? 0);
            await sleep(200);
          }
        }
        updated++;
      }

    } catch (err) {
      warn(`Error syncing ${rp.code}: ${err.message}`);
      failed++;
    }

    // Progress every 10 products
    if ((i + 1) % 10 === 0 || i === products.length - 1) {
      log(`Progress: ${i + 1}/${products.length} | ✅ created:${created} updated:${updated} skipped:${skipped} ❌ failed:${failed}`);
    }

    await sleep(SHOPIFY_DELAY);
  }

  // Save cursor for next incremental sync (wall-clock anchored, see above)
  fs.writeFileSync(LAST_UPDATE_FILE, syncCursor);
  log(`Saved sync cursor: ${syncCursor}`);

  log(`\n✅  Sync complete — created: ${created}, updated: ${updated}, failed: ${failed}`);
}

run().catch(err => {
  console.error('\n❌  Fatal error:', err.message);
  process.exit(1);
});
