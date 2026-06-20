/**
 * cleanup_orphans_and_duplicates.cjs
 * ─────────────────────────────────────────────────────────────
 * DRY RUN BY DEFAULT. Nothing is ever deleted — only ARCHIVED (status set
 * to 'archived'), which keeps the product and all its order history but
 * removes it from the active storefront/catalog. Run with --apply to
 * actually perform the archiving after reviewing the dry-run output.
 *
 * Scope: only products tagged 'RewixSync' (the tag this sync stamps on
 * every product it creates). Products from other supplier pipelines or
 * manual entries are never touched.
 *
 * MATCHING: each Shopify product is matched back to a Rewix product ID by
 * its variant SKUs/model IDs against a fresh full Rewix catalog fetch — the
 * SAME matching logic sync.js already uses (bare code, size-suffixed code,
 * REWIXSYNCRM-{modelId} legacy format). This deliberately does NOT use the
 * rewix/product_id metafield: since sync.js only writes metafields on
 * product CREATE (existing products are price/quantity-only now), most of
 * the catalog would never have that metafield and this script would skip
 * almost everything. SKU/model matching works on the whole catalog today.
 *
 * Two passes:
 *   1. DUPLICATES — multiple Shopify products whose variants resolve to the
 *      same Rewix product ID. Keeps the most complete listing (active >
 *      most variants > most recently updated), archives the rest.
 *   2. ORPHANS — products where NONE of the variants resolve to anything in
 *      the current Rewix feed at all (Romanelli removed the listing
 *      entirely). Tagged 'rewix-orphan' and archived.
 *
 * Usage:
 *   node cleanup_orphans_and_duplicates.cjs            ← dry run, report only
 *   node cleanup_orphans_and_duplicates.cjs --apply     ← actually archive
 */

require('dotenv').config();
const fs = require('fs');

const REWIX_BASE_URL = process.env.REWIX_BASE_URL;
const REWIX_API_KEY  = process.env.REWIX_API_KEY;
const REWIX_PASSWORD = process.env.REWIX_PASSWORD;
const SHOPIFY_STORE  = process.env.SHOPIFY_STORE;
const SHOPIFY_TOKEN  = process.env.SHOPIFY_TOKEN;

const SHOPIFY_API_VERSION = '2024-01';
const LOCALES = 'en_US,de_DE';
const SHOPIFY_DELAY = 600;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const log  = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);
const warn = (msg) => console.warn(`[${new Date().toISOString()}] ⚠  ${msg}`);
const basicAuth = () => Buffer.from(`${REWIX_API_KEY}:${REWIX_PASSWORD}`).toString('base64');
const shopifyBase = () => `https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}`;
const shopifyHeaders = () => ({
  'Content-Type': 'application/json',
  'X-Shopify-Access-Token': SHOPIFY_TOKEN,
});
const adminUrl = (id) => `https://${SHOPIFY_STORE}/admin/products/${id}`;

// ─── REWIX: full catalog → lookup maps for matching ──────────────────────────

async function fetchRewixLookupMaps() {
  log('Fetching FULL Rewix catalog to build code/model-id → product-id lookup maps…');
  const params = new URLSearchParams({ v: 'TEAL', acceptedlocales: LOCALES });
  const url = `${REWIX_BASE_URL}/restful/export/api/products.json?${params}`;
  const res = await fetch(url, {
    headers: { Authorization: `Basic ${basicAuth()}`, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Rewix API error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const products = data.pageItems || [];

  // bare model code → Rewix product id (matches sync.js's primary SKU strategy)
  const codeToProductId = new Map();
  // Rewix model id → Rewix product id (matches sync.js's REWIXSYNCRM legacy strategy)
  const modelIdToProductId = new Map();

  for (const rp of products) {
    for (const m of rp.models || []) {
      if (m.code) codeToProductId.set(m.code, String(rp.id));
      if (m.id != null) modelIdToProductId.set(m.id, String(rp.id));
    }
  }
  log(`Live Rewix products: ${products.length} | model codes: ${codeToProductId.size} | model ids: ${modelIdToProductId.size}`);
  return { codeToProductId, modelIdToProductId };
}

// Resolves a single Shopify variant SKU back to a Rewix product id, using the
// same three strategies sync.js uses to go the other direction:
//   1. exact bare code match
//   2. size-suffixed SKU (strip a trailing "-{slug}" and retry as bare code)
//   3. legacy REWIXSYNCRM-{modelId} format
function resolveSkuToRewixProductId(sku, codeToProductId, modelIdToProductId) {
  if (!sku) return null;
  if (codeToProductId.has(sku)) return codeToProductId.get(sku);

  const legacyMatch = sku.match(/^REWIXSYNCRM-(\d+)$/i);
  if (legacyMatch) {
    const modelId = parseInt(legacyMatch[1], 10);
    if (modelIdToProductId.has(modelId)) return modelIdToProductId.get(modelId);
  }

  // Strip a trailing size suffix (one or more hyphen-joined segments) and
  // retry — handles "code-S-M", "code-42", etc. without guessing how many
  // segments the size itself contains.
  const parts = sku.split('-');
  for (let cut = parts.length - 1; cut >= 1; cut--) {
    const candidate = parts.slice(0, cut).join('-');
    if (codeToProductId.has(candidate)) return codeToProductId.get(candidate);
  }
  return null;
}

// Resolves a whole Shopify product to the set of distinct Rewix product ids
// any of its variants match. Normally 0 (orphan) or 1 (live) — more than 1
// is flagged separately as ambiguous rather than guessed at.
function resolveProductRewixIds(product, codeToProductId, modelIdToProductId) {
  const ids = new Set();
  for (const v of product.variants || []) {
    const id = resolveSkuToRewixProductId(v.sku, codeToProductId, modelIdToProductId);
    if (id) ids.add(id);
  }
  return [...ids];
}

// ─── SHOPIFY: all RewixSync-tagged products + their rewix/product_id metafield ─

async function fetchRewixSyncProducts() {
  log('Fetching Shopify products tagged "RewixSync"…');
  const products = [];
  // Shopify's product list supports tag filtering via search, but the REST
  // products.json endpoint doesn't filter by tag directly — pull everything
  // and filter client-side (matches the approach already used in sync.js's
  // loadShopifyIndex, so behavior stays consistent).
  let url = `${shopifyBase()}/products.json?limit=250&fields=id,title,tags,status,variants,updated_at`;
  while (url) {
    const res = await fetch(url, { headers: shopifyHeaders() });
    if (!res.ok) throw new Error(`Shopify error: ${res.status}`);
    const data = await res.json();
    for (const p of data.products || []) {
      const tags = (p.tags || '').split(',').map(t => t.trim().toLowerCase());
      if (tags.includes('rewixsync')) products.push(p);
    }
    const link = res.headers.get('Link') || '';
    const next = link.match(/<([^>]+)>;\s*rel="next"/)?.[1];
    url = next || null;
    if (url) await sleep(SHOPIFY_DELAY);
  }
  log(`RewixSync-tagged products in Shopify: ${products.length}`);
  return products;
}

async function archiveProduct(productId, extraTag = null) {
  const body = { product: { id: productId, status: 'archived' } };
  if (extraTag) {
    // Fetch current tags first so we append rather than overwrite.
    const cur = await fetch(`${shopifyBase()}/products/${productId}.json?fields=tags`, { headers: shopifyHeaders() });
    const { product } = await cur.json();
    const tags = (product?.tags || '').split(',').map(t => t.trim()).filter(Boolean);
    if (!tags.some(t => t.toLowerCase() === extraTag.toLowerCase())) tags.push(extraTag);
    body.product.tags = tags.join(', ');
  }
  const res = await fetch(`${shopifyBase()}/products/${productId}.json`, {
    method: 'PUT', headers: shopifyHeaders(), body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    warn(`Archive failed (${productId}): ${JSON.stringify(err.errors || err)}`);
    return false;
  }
  return true;
}

// Picks which product to KEEP among a duplicate group: prefer active status,
// then more variants (more complete listing), then most recently updated.
function pickKeeper(group) {
  return [...group].sort((a, b) => {
    if ((a.status === 'active') !== (b.status === 'active')) {
      return a.status === 'active' ? -1 : 1;
    }
    const aVariants = (a.variants || []).length;
    const bVariants = (b.variants || []).length;
    if (aVariants !== bVariants) return bVariants - aVariants;
    return new Date(b.updated_at) - new Date(a.updated_at);
  })[0];
}

async function run() {
  const apply = process.argv.includes('--apply');
  const required = ['REWIX_BASE_URL', 'REWIX_API_KEY', 'REWIX_PASSWORD', 'SHOPIFY_STORE', 'SHOPIFY_TOKEN'];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length) {
    console.error(`❌ Missing env vars: ${missing.join(', ')}`);
    process.exit(1);
  }

  console.log('='.repeat(70));
  console.log(apply ? '⚠️  LIVE MODE — products WILL be archived' : '🔍 DRY RUN — no changes will be made (use --apply to execute)');
  console.log('='.repeat(70));

  const { codeToProductId, modelIdToProductId } = await fetchRewixLookupMaps();
  const shopifyProducts = await fetchRewixSyncProducts();

  log('Matching each Shopify product to a Rewix product id via SKU/model-id…');
  const resolved = [];      // { ...product, rewixProductId }
  const orphans = [];       // matched nothing at all
  const ambiguous = [];     // matched more than one distinct Rewix product (manual review)

  for (const p of shopifyProducts) {
    const ids = resolveProductRewixIds(p, codeToProductId, modelIdToProductId);
    if (ids.length === 0) {
      orphans.push(p);
    } else if (ids.length === 1) {
      resolved.push({ ...p, rewixProductId: ids[0] });
    } else {
      ambiguous.push({ ...p, rewixProductIds: ids });
    }
  }

  if (ambiguous.length > 0) {
    warn(`${ambiguous.length} product(s) had variants matching MORE THAN ONE Rewix product id — `
       + `left untouched, flagged in the CSV as "ambiguous_needs_review" rather than guessed at.`);
  }

  // ── Pass 1: duplicates ──────────────────────────────────────────
  const groups = new Map();
  for (const p of resolved) {
    if (!groups.has(p.rewixProductId)) groups.set(p.rewixProductId, []);
    groups.get(p.rewixProductId).push(p);
  }

  const duplicateActions = []; // { keep, archive: [...] }
  for (const [rewixId, group] of groups) {
    if (group.length <= 1) continue;
    const keeper = pickKeeper(group);
    const toArchive = group.filter(p => p.id !== keeper.id);
    duplicateActions.push({ rewixId, keeper, toArchive });
  }

  // ── Pass 2: orphans (already isolated above — just exclude archived) ────
  const orphanCandidates = orphans.filter(p => p.status !== 'archived');

  // ── Report ────────────────────────────────────────────────────
  console.log('\n--- DUPLICATES ---');
  console.log(`Rewix product IDs with more than one Shopify listing: ${duplicateActions.length}`);
  let dupArchiveCount = 0;
  for (const { rewixId, keeper, toArchive } of duplicateActions) {
    console.log(`\n  rewix product id = ${rewixId}`);
    console.log(`    KEEP    [${keeper.status}] ${keeper.title} — ${adminUrl(keeper.id)}`);
    for (const p of toArchive) {
      console.log(`    ARCHIVE [${p.status}] ${p.title} — ${adminUrl(p.id)}`);
      dupArchiveCount++;
    }
  }
  console.log(`\nTotal to archive as duplicates: ${dupArchiveCount}`);

  console.log('\n--- ORPHANS (no variant matches anything in Romanelli\'s live feed) ---');
  console.log(`Total: ${orphanCandidates.length}`);
  for (const p of orphanCandidates.slice(0, 50)) {
    console.log(`  [${p.status}] ${p.title} — ${adminUrl(p.id)}`);
  }
  if (orphanCandidates.length > 50) console.log(`  … and ${orphanCandidates.length - 50} more (see CSV)`);

  // ── CSV report (always written, even in dry run) ────────────────
  const csvRows = ['action,product_id,title,status,rewix_product_id,admin_url'];
  for (const { toArchive } of duplicateActions) {
    for (const p of toArchive) {
      csvRows.push(`archive_duplicate,${p.id},"${p.title.replace(/"/g, '""')}",${p.status},${p.rewixProductId},${adminUrl(p.id)}`);
    }
  }
  for (const p of orphanCandidates) {
    csvRows.push(`archive_orphan,${p.id},"${p.title.replace(/"/g, '""')}",${p.status},,${adminUrl(p.id)}`);
  }
  for (const p of ambiguous) {
    csvRows.push(`ambiguous_needs_review,${p.id},"${p.title.replace(/"/g, '""')}",${p.status},"${p.rewixProductIds.join('|')}",${adminUrl(p.id)}`);
  }
  fs.writeFileSync('cleanup_report.csv', csvRows.join('\n'));
  console.log(`\n📄 Full report written to cleanup_report.csv`);

  if (!apply) {
    console.log('\n🔍 This was a DRY RUN. No changes were made.');
    console.log('   Review cleanup_report.csv, then re-run with --apply to archive these products.');
    return;
  }

  // ── Apply ────────────────────────────────────────────────────────
  console.log('\n⚠️  Applying changes…');
  let archived = 0, failed = 0;
  for (const { toArchive } of duplicateActions) {
    for (const p of toArchive) {
      const ok = await archiveProduct(p.id, 'rewix-duplicate');
      ok ? archived++ : failed++;
      await sleep(SHOPIFY_DELAY);
    }
  }
  for (const p of orphanCandidates) {
    const ok = await archiveProduct(p.id, 'rewix-orphan');
    ok ? archived++ : failed++;
    await sleep(SHOPIFY_DELAY);
  }
  console.log(`\n✅ Done. Archived: ${archived}, Failed: ${failed}`);
}

run().catch(err => {
  console.error('❌ Fatal error:', err.message);
  process.exit(1);
});
