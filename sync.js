/**
 * Rewix → Shopify Product Sync
 * ─────────────────────────────────────────────────────────────
 * • Fetches products from the Rewix API
 * • NEW products: created with full title/tags/category/metafields/images.
 * • EXISTING products: price + quantity + cost-per-item ONLY. Title, tags,
 *   category, status, metafields, and images are set once at import and
 *   never overwritten again — manual edits in Shopify persist indefinitely.
 *   Exception: a product auto-drafted for a pricing issue is auto-reactivated
 *   once the feed prices it cleanly (see reactivateIfPriceResolved).
 * • Incremental sync — only changed products after the first run
 *
 * Usage:
 *   node sync.js          ← smart sync (full first time, incremental after)
 *   node sync.js --full   ← force a full catalog re-download
 */

require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const { buildTitle, translateCategory, translateSubcategory,
        normalizeMadeIn, normalizeSeason, normalizeGender } = require('./translate.cjs');

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

// ─── DEDUPE: collapse feed rows that resolve to the same SKU ──────────────────
// Romanelli's feed sometimes sends multiple model entries for the exact same
// code+size combination (one Shopify product was seen with 4 identical
// "S-M" rows, same SKU, each a separate Rewix model id — almost certainly
// split warehouse/batch allocations on their side). Left unmerged, every
// duplicate becomes its own Shopify variant with an identical SKU and
// identical option values, which both bloats the catalog/run time AND
// corrupts inventory: each duplicate's availability gets SET (not added) on
// the same Shopify variant, so only whichever one synced last "wins" instead
// of the true total being reflected.
function buildSkuFor(m) {
  const sizeRaw = (m.size != null ? String(m.size) : '').trim();
  const sizeSlug = sizeRaw.replace(/\s+/g, '-');
  // .trim() here matters: Rewix's API has been observed returning the same
  // model's `code` with inconsistent leading/trailing whitespace across
  // separate calls. Untrimmed, the computed SKU differs at the byte level
  // between runs even though it displays identically in Shopify's UI — so
  // the matching index never finds the existing product, and sync.js
  // recreates it as new on every single full sync, forever.
  let sku = (m.code || '').trim();
  if (sizeSlug && !new RegExp(`-${sizeSlug}$`, 'i').test(sku)) {
    sku = sku ? `${sku}-${sizeSlug}` : sizeSlug;
  }
  return sku;
}

function dedupeModelsBySku(models) {
  const bySku = new Map();
  for (const m of models) {
    const sku = buildSkuFor(m);
    if (!bySku.has(sku)) {
      bySku.set(sku, { ...m });
    } else {
      const kept = bySku.get(sku);
      kept.availability = (kept.availability ?? 0) + (m.availability ?? 0);
      // Backfill anything the first-seen duplicate happened to be missing.
      if (!kept.barcode && m.barcode) kept.barcode = m.barcode;
      if ((kept.taxable == null || kept.taxable === '') && m.taxable != null) kept.taxable = m.taxable;
      if ((kept.bestTaxable == null || kept.bestTaxable === '') && m.bestTaxable != null) kept.bestTaxable = m.bestTaxable;
      if ((kept.streetPrice == null || kept.streetPrice === '') && m.streetPrice != null) kept.streetPrice = m.streetPrice;
    }
  }
  return [...bySku.values()];
}

/**
 * Build a Shopify product payload from a Rewix product.
 */
function buildShopifyPayload(rp) {
  const brand          = tagValueEN(rp.tags, 'brand')       || '';
  const categoryRaw    = tagValueEN(rp.tags, 'category')    || '';
  const genderRaw      = tagValueEN(rp.tags, 'gender')      || '';
  const seasonRaw      = tagValueEN(rp.tags, 'season')      || '';
  const color          = tagValueEN(rp.tags, 'color')       || '';
  const subcategoryRaw = tagValueEN(rp.tags, 'subcategory') || '';
  // Composition: try tag first, then top-level field (Rewix API exposes both paths
  // depending on the supplier's catalog setup)
  const composition    = tagValueEN(rp.tags, 'composition') || rp.composition || '';

  const gender = normalizeGender(genderRaw);
  const season = normalizeSeason(seasonRaw);

  // Rewix category/subcategory tags are Italian with no en_US locale, so
  // tagValueEN returns the raw Italian. Translate explicitly for product_type
  // and tags. (type tag is empty in the feed, so it's intentionally unused.)
  const category    = translateCategory(categoryRaw);
  const subcategory = translateSubcategory(subcategoryRaw);

  // ── Title ─────────────────────────────────────────────────────
  // Always built by the validated dictionary translator (translate.cjs) —
  // this is the fix_titles.cjs logic, applied at import time so products
  // are born correct instead of needing a backfill. Uses the English
  // subcategory so the garment-noun fallback inside buildTitle is English too.
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

  const dedupedModels = dedupeModelsBySku(rp.models || []);

  const variants = dedupedModels.map(m => {
    const { price, compareAt, reviewReason } = computeVariantPricing(m);
    if (reviewReason === 'no-cost') hasNoCost = true;
    if (reviewReason === 'unprofitable') hasUnprofitable = true;

    // Unique SKU: Rewix gives every size of a product the SAME m.code, which
    // collapses variants / spawns duplicates in Shopify and breaks the SKU
    // index. The size lives in m.size (modelLocalizations.size is empty), so
    // append it. Guard against double-suffixing if the code already ends in it.
    const sku = buildSkuFor(m);

    return {
      sku:                  sku || undefined,
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
  // Metafields are included in both create and update payloads. Shopify
  // deduplicates by namespace+key on PUT, so this is safe to send every run.
  const metafields = [
    { namespace: 'rewix', key: 'product_code',  value: rp.code,                          type: 'single_line_text_field' },
    { namespace: 'rewix', key: 'product_id',    value: String(rp.id),                    type: 'single_line_text_field' },
    rp.hs       && { namespace: 'rewix', key: 'hs_code',     value: rp.hs,                        type: 'single_line_text_field' },
    rp.madein   && { namespace: 'rewix', key: 'made_in',     value: normalizeMadeIn(rp.madein),   type: 'single_line_text_field' },
    subcategory && { namespace: 'rewix', key: 'subcategory', value: subcategory,                  type: 'single_line_text_field' },
    gender      && { namespace: 'rewix', key: 'gender',      value: gender,                       type: 'single_line_text_field' },
    season      && { namespace: 'rewix', key: 'season',      value: season,                       type: 'single_line_text_field' },
    composition && { namespace: 'rewix', key: 'composition', value: composition,                  type: 'single_line_text_field' },
  ].filter(Boolean);

  return {
    hasNoCost,
    hasUnprofitable,
    dedupedModels,
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

  // Back to basics: match on the exact variant SKU only (code + size/color,
  // computed deterministically by buildSkuFor — same function used to build
  // the SKU at create time). No bare-code reconstruction, no metafield
  // dependency — both were fragile and didn't reliably fix the duplicates.
  //
  // 1. skuToProductId — exact variant SKU → Shopify product id.
  // 2. skuVariantId    — exact variant SKU → variant id (for inventory/price updates).
  // 3. modelIdToData   — Rewix model id → { productId, variantId }, kept as a
  //    legacy fallback for any products still on the old "REWIXSYNCRM-{id}" SKU.
  const skuToProductId = new Map();
  const skuVariantId   = new Map();
  const modelIdToData  = new Map();
  const productMeta    = new Map(); // productId -> { tags, status } for manual-hold checks

  let url = `${shopifyBase()}/products.json?limit=250&fields=id,variants,tags,status`;
  while (url) {
    const res = await fetch(url, { headers: shopifyHeaders() });
    if (!res.ok) throw new Error(`Shopify index error: ${res.status}`);
    const data = await res.json();
    for (const p of data.products || []) {
      productMeta.set(p.id, { tags: p.tags || '', status: p.status });
      for (const v of p.variants || []) {
        if (!v.sku) continue;
        if (!skuToProductId.has(v.sku)) skuToProductId.set(v.sku, p.id);
        skuVariantId.set(v.sku, v.id);
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
  log(`Shopify index built: ${skuVariantId.size} variants indexed (${rewixSyncCount} from RewixSync app).`);
  return { skuToProductId, skuVariantId, modelIdToData, productMeta };
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

/**
 * Lightweight per-variant price update. This is the ONLY write that touches
 * existing products on every sync run — title, tags, status, category,
 * metafields, and images are set once at creation and never overwritten
 * again. This is a deliberate behavior change (June 2026): products are
 * "born correct" from the import logic above, then left alone so manual
 * edits in Shopify (recategorization, copy tweaks, manual tagging) survive
 * indefinitely instead of being reverted by the next sync.
 */
async function updateVariantPriceOnly(variantId, price, compareAt) {
  const variant = { id: variantId, price: price.toFixed(2) };
  if (compareAt) variant.compare_at_price = compareAt.toFixed(2);
  const res = await fetch(`${shopifyBase()}/variants/${variantId}.json`, {
    method: 'PUT', headers: shopifyHeaders(),
    body: JSON.stringify({ variant }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    warn(`Variant price update failed (${variantId}): ${JSON.stringify(err.errors || err)}`);
  }
}

/**
 * Reactivates a product that was previously drafted by sync itself for a
 * pricing reason ('needs-price-review' / 'rewix-unprofitable') once the feed
 * now prices it cleanly. This is the ONE exception to "status is frozen
 * after import" — without it, the 488 zero-price products from the original
 * incident would stay drafted forever even after their price is fixed,
 * since nothing else ever flips status back. Manual drafts (no review tag)
 * are never touched.
 */
async function reactivateIfPriceResolved(productId, currentTags, stillFlagged) {
  if (stillFlagged) return false;
  const wasFlagged = /(needs-price-review|rewix-unprofitable)/i.test(currentTags || '');
  if (!wasFlagged) return false;
  const cleanedTags = (currentTags || '')
    .split(',').map(t => t.trim())
    .filter(t => t && !/^(needs-price-review|rewix-unprofitable)$/i.test(t))
    .join(', ');
  const res = await fetch(`${shopifyBase()}/products/${productId}.json`, {
    method: 'PUT', headers: shopifyHeaders(),
    body: JSON.stringify({ product: { id: productId, status: 'active', tags: cleanedTags } }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    warn(`Reactivation failed (${productId}): ${JSON.stringify(err.errors || err)}`);
    return false;
  }
  return true;
}

async function updateVariantInventory(variantId, quantity, cost = null, locationId = null) {
  const vRes = await fetch(`${shopifyBase()}/variants/${variantId}.json`, { headers: shopifyHeaders() });
  if (!vRes.ok) return;
  const { variant } = await vRes.json();

  // Write wholesale cost into Shopify's "Cost per item" (inventory_item.cost).
  // This is the real Rewix cost (taxable) we already used to compute the price,
  // so margin reporting in Shopify matches what sync actually charged.
  if (cost != null && Number.isFinite(cost) && cost > 0 && variant.inventory_item_id) {
    await fetch(`${shopifyBase()}/inventory_items/${variant.inventory_item_id}.json`, {
      method: 'PUT', headers: shopifyHeaders(),
      body: JSON.stringify({ inventory_item: { id: variant.inventory_item_id, cost: cost.toFixed(2) } }),
    });
    await sleep(150);
  }

  // locationId is resolved once per run by the caller and passed in.
  // Fetching /locations.json per-variant added ~12-15 min to every run.
  if (!locationId) {
    const locRes = await fetch(`${shopifyBase()}/locations.json`, { headers: shopifyHeaders() });
    const { locations } = await locRes.json();
    const location = locations?.find(l => l.name === '3169 Warehouse') || locations?.[0];
    locationId = location?.id;
  }
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
  const { skuToProductId, skuVariantId, modelIdToData, productMeta } = await loadShopifyIndex();

  // Resolve the warehouse location once — passing it to updateVariantInventory
  // avoids re-fetching /locations.json on every variant (was adding ~12-15 min/run).
  let warehouseLocationId = null;
  try {
    const locRes = await fetch(`${shopifyBase()}/locations.json`, { headers: shopifyHeaders() });
    const { locations } = await locRes.json();
    const loc = locations?.find(l => l.name === '3169 Warehouse') || locations?.[0];
    warehouseLocationId = loc?.id || null;
    if (warehouseLocationId) log(`Warehouse location resolved: ${loc.name} (${warehouseLocationId})`);
    else warn('Location "3169 Warehouse" not found — inventory updates will be skipped');
  } catch (e) {
    warn(`Could not resolve warehouse location: ${e.message}`);
  }

  let created = 0, updated = 0, skipped = 0, failed = 0;

  for (let i = 0; i < products.length; i++) {
    const rp         = products[i];
    const firstModel = rp.models?.[0];

    // Match strategy 1: full computed SKU (code+size, same function used to
    // build the SKU at create time) — check every model, not just the first,
    // since any one of them existing in Shopify means the product already
    // exists. Looking up the bare `m.code` here (as before) never matches,
    // because the index only stores the full size-suffixed SKU.
    let existingId = null;
    for (const m of rp.models || []) {
      existingId = skuToProductId.get(buildSkuFor(m));
      if (existingId) break;
    }

    // Match strategy 2: RewixSync app format "REWIXSYNCRM-{modelId}"
    if (!existingId && firstModel?.id) {
      existingId = modelIdToData.get(firstModel.id)?.productId || null;
      if (existingId) log(`  🔗 Matched via RewixSync model ID ${firstModel.id} → Shopify product ${existingId}`);
    }

    const isNew = !existingId;
    if (isNew) {
      log(`  ➕ Creating (no match found): code="${(firstModel?.code || '').trim()}" rewixId=${rp.id} title="${rp.name || ''}"`);
    }

    try {
      const payload = buildShopifyPayload(rp);

      if (isNew) {
        const newProduct = await createShopifyProduct(payload);
        if (newProduct) {
          for (const v of newProduct.variants || []) {
            if (!v.sku) continue;
            skuToProductId.set(v.sku, newProduct.id);
            skuVariantId.set(v.sku, v.id);
            const bare = v.sku.replace(/-[^-]+$/, '');
            if (bare && bare !== v.sku && !skuToProductId.has(bare)) skuToProductId.set(bare, newProduct.id);
          }
          // Set wholesale cost + stock on the new variants. Match each created
          // variant back to its feed model by the size-suffixed SKU. Uses the
          // deduped model list so duplicate feed rows for the same SKU don't
          // fire redundant (and order-dependent) inventory writes.
          for (const m of payload.dedupedModels) {
            const suffixedSku = buildSkuFor(m);
            const vid = skuVariantId.get(suffixedSku) || skuVariantId.get((m.code || '').trim());
            if (vid) {
              const costRaw = m.taxable ?? m.bestTaxable;
              const cost = (costRaw != null && costRaw !== '') ? parseFloat(costRaw) : null;
              await updateVariantInventory(vid, m.availability ?? 0, cost, warehouseLocationId);
              await sleep(200);
            }
          }
          created++;
        } else {
          failed++;
        }
      } else {
        // Existing product — PRICE + QUANTITY ONLY (+ cost-per-item, which
        // travels with price since it's the margin input). Title, tags,
        // category, status, metafields and images are intentionally left
        // alone post-import — only the per-variant pricing/inventory calls
        // below ever touch an existing product.
        //
        // Exception: a product manually drafted with 'manual-hold' is left
        // completely untouched, including price/quantity — that tag means
        // "I'm managing this one by hand."
        const meta = productMeta.get(existingId);
        const manualHold = /(^|,)\s*manual-hold\s*(,|$)/i.test(meta?.tags || '');

        if (manualHold) {
          log(`  ✋ manual-hold respected for product ${existingId} (no fields touched)`);
          skipped++;
          continue;
        }

        const stillFlagged = payload.hasNoCost || payload.hasUnprofitable;
        const reactivated = await reactivateIfPriceResolved(existingId, meta?.tags, stillFlagged);
        if (reactivated) log(`  ♻️  Reactivated product ${existingId} — price issue resolved`);

        for (let mi = 0; mi < payload.dedupedModels.length; mi++) {
          const m = payload.dedupedModels[mi];
          const v = payload.product.variants[mi];
          // Reconstruct the same size-suffixed SKU we write on import, then fall
          // back to bare code (old scheme) and finally the RewixSync model id.
          const suffixedSku = buildSkuFor(m);
          const vid = skuVariantId.get(suffixedSku)
                   || skuVariantId.get((m.code || '').trim())
                   || modelIdToData.get(m.id)?.variantId;
          if (vid) {
            await updateVariantPriceOnly(
              vid,
              parseFloat(v.price),
              v.compare_at_price ? parseFloat(v.compare_at_price) : null
            );
            const costRaw = m.taxable ?? m.bestTaxable;
            const cost = (costRaw != null && costRaw !== '') ? parseFloat(costRaw) : null;
            await updateVariantInventory(vid, m.availability ?? 0, cost, warehouseLocationId);
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
