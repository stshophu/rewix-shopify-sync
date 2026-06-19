/**
 * merge_duplicate_variants.cjs
 * ─────────────────────────────────────────────────────────────
 * ONE-OFF CLEANUP for duplicate variants already sitting in Shopify from
 * BEFORE sync.js started deduping Romanelli's duplicate model rows
 * (same code+size, split batch allocations on their side).
 *
 * sync.js's dedupeModelsBySku() now prevents NEW duplicates on import, but
 * it doesn't retroactively touch variants that were already created by
 * earlier runs — like 4x "rosso / S-M" with the identical SKU on one
 * product. This script finds and fixes those.
 *
 * For each product, variants are grouped by a normalized key:
 * SKU if present, else (option1+option2+option3) with whitespace collapsed.
 * Within any group of >1:
 *   - keeps the variant Shopify considers "first" (lowest id = oldest)
 *   - adds every other variant's current inventory onto the survivor
 *     (via inventory_levels/adjust — additive, no stock is lost)
 *   - DELETES the extra variant(s)
 *
 * DRY RUN BY DEFAULT — reports what it would do, makes zero writes.
 *
 * Usage:
 *   node merge_duplicate_variants.cjs            ← dry run, report only
 *   node merge_duplicate_variants.cjs --apply     ← actually merge + delete
 */

require('dotenv').config();
const fs = require('fs');

const SHOPIFY_STORE = process.env.SHOPIFY_STORE;
const SHOPIFY_TOKEN = process.env.SHOPIFY_TOKEN;
const SHOPIFY_API_VERSION = '2024-01';
const SHOPIFY_DELAY = 600;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const log  = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);
const warn = (msg) => console.warn(`[${new Date().toISOString()}] ⚠  ${msg}`);
const shopifyBase = () => `https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}`;
const shopifyHeaders = () => ({
  'Content-Type': 'application/json',
  'X-Shopify-Access-Token': SHOPIFY_TOKEN,
});
const adminUrl = (id) => `https://${SHOPIFY_STORE}/admin/products/${id}`;

function normKey(v) {
  if (v.sku && v.sku.trim()) return `sku:${v.sku.trim()}`;
  const parts = [v.option1, v.option2, v.option3]
    .map(o => (o || '').trim().replace(/\s+/g, ' '))
    .join('|');
  return `opts:${parts}`;
}

async function fetchAllProductsWithVariants() {
  log('Fetching all Shopify products (this can take a while for a large catalog)…');
  const products = [];
  let url = `${shopifyBase()}/products.json?limit=250&fields=id,title,variants`;
  while (url) {
    const res = await fetch(url, { headers: shopifyHeaders() });
    if (!res.ok) throw new Error(`Shopify error: ${res.status}`);
    const data = await res.json();
    products.push(...(data.products || []));
    const link = res.headers.get('Link') || '';
    const next = link.match(/<([^>]+)>;\s*rel="next"/)?.[1];
    url = next || null;
    if (url) await sleep(SHOPIFY_DELAY);
  }
  log(`Fetched ${products.length} products.`);
  return products;
}

async function resolveWarehouseLocationId() {
  const res = await fetch(`${shopifyBase()}/locations.json`, { headers: shopifyHeaders() });
  const { locations } = await res.json();
  const loc = locations?.find(l => l.name === '3169 Warehouse') || locations?.[0];
  return loc?.id || null;
}

async function adjustInventory(inventoryItemId, locationId, delta) {
  if (!delta) return;
  const res = await fetch(`${shopifyBase()}/inventory_levels/adjust.json`, {
    method: 'POST', headers: shopifyHeaders(),
    body: JSON.stringify({
      inventory_item_id: inventoryItemId,
      location_id: locationId,
      available_adjustment: delta,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    warn(`Inventory adjust failed: ${JSON.stringify(err.errors || err)}`);
  }
}

async function deleteVariant(productId, variantId) {
  const res = await fetch(`${shopifyBase()}/products/${productId}/variants/${variantId}.json`, {
    method: 'DELETE', headers: shopifyHeaders(),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    warn(`Delete failed (variant ${variantId}): ${JSON.stringify(err.errors || err)}`);
    return false;
  }
  return true;
}

async function run() {
  const apply = process.argv.includes('--apply');
  if (!SHOPIFY_STORE || !SHOPIFY_TOKEN) {
    console.error('❌ Missing SHOPIFY_STORE / SHOPIFY_TOKEN env vars.');
    process.exit(1);
  }

  console.log('='.repeat(70));
  console.log(apply ? '⚠️  LIVE MODE — duplicate variants WILL be deleted' : '🔍 DRY RUN — no changes will be made (use --apply to execute)');
  console.log('='.repeat(70));

  const products = await fetchAllProductsWithVariants();

  const actions = []; // { productId, title, survivor, extras: [...] }
  let totalExtraVariants = 0;

  for (const p of products) {
    const variants = p.variants || [];
    if (variants.length <= 1) continue;

    const groups = new Map();
    for (const v of variants) {
      const key = normKey(v);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(v);
    }

    for (const [key, group] of groups) {
      if (group.length <= 1) continue;
      // Keep the lowest variant id (oldest / first-created).
      const sorted = [...group].sort((a, b) => a.id - b.id);
      const survivor = sorted[0];
      const extras = sorted.slice(1);
      actions.push({ productId: p.id, title: p.title, key, survivor, extras });
      totalExtraVariants += extras.length;
    }
  }

  // ── Report ────────────────────────────────────────────────────
  console.log(`\nProducts with at least one duplicate-variant group: ${actions.length}`);
  console.log(`Total extra (duplicate) variants to remove: ${totalExtraVariants}`);

  for (const a of actions.slice(0, 30)) {
    const extraQty = a.extras.reduce((s, v) => s + (v.inventory_quantity || 0), 0);
    console.log(`\n  ${a.title} — ${adminUrl(a.productId)}`);
    console.log(`    KEEP   variant ${a.survivor.id}  sku="${a.survivor.sku || ''}"  qty=${a.survivor.inventory_quantity || 0}`);
    for (const v of a.extras) {
      console.log(`    REMOVE variant ${v.id}  sku="${v.sku || ''}"  qty=${v.inventory_quantity || 0}`);
    }
    if (extraQty) console.log(`    → ${extraQty} units will be added onto the kept variant`);
  }
  if (actions.length > 30) console.log(`\n  … and ${actions.length - 30} more products (see CSV)`);

  // ── CSV ────────────────────────────────────────────────────────
  const csvRows = ['product_id,title,action,variant_id,sku,quantity,admin_url'];
  for (const a of actions) {
    csvRows.push(`${a.productId},"${a.title.replace(/"/g, '""')}",keep,${a.survivor.id},"${a.survivor.sku || ''}",${a.survivor.inventory_quantity || 0},${adminUrl(a.productId)}`);
    for (const v of a.extras) {
      csvRows.push(`${a.productId},"${a.title.replace(/"/g, '""')}",remove,${v.id},"${v.sku || ''}",${v.inventory_quantity || 0},${adminUrl(a.productId)}`);
    }
  }
  fs.writeFileSync('merge_duplicate_variants_report.csv', csvRows.join('\n'));
  console.log(`\n📄 Full report written to merge_duplicate_variants_report.csv`);

  if (!apply) {
    console.log('\n🔍 This was a DRY RUN. No changes were made.');
    console.log('   Review the CSV, then re-run with --apply to merge and delete.');
    return;
  }

  // ── Apply ────────────────────────────────────────────────────────
  console.log('\n⚠️  Applying changes…');
  const locationId = await resolveWarehouseLocationId();
  if (!locationId) {
    console.error('❌ Could not resolve a warehouse location — aborting, nothing was changed.');
    process.exit(1);
  }

  let merged = 0, deleted = 0, failed = 0;
  for (const a of actions) {
    // Find the survivor's inventory_item_id (need a fresh variant fetch — the
    // products.json list response doesn't include inventory_item_id).
    const vRes = await fetch(`${shopifyBase()}/variants/${a.survivor.id}.json`, { headers: shopifyHeaders() });
    const { variant: survivorFull } = vRes.ok ? await vRes.json() : { variant: null };
    await sleep(SHOPIFY_DELAY);

    const extraQty = a.extras.reduce((s, v) => s + (v.inventory_quantity || 0), 0);
    if (extraQty > 0 && survivorFull?.inventory_item_id) {
      await adjustInventory(survivorFull.inventory_item_id, locationId, extraQty);
      await sleep(SHOPIFY_DELAY);
      merged++;
    }

    for (const v of a.extras) {
      const ok = await deleteVariant(a.productId, v.id);
      ok ? deleted++ : failed++;
      await sleep(SHOPIFY_DELAY);
    }
  }

  console.log(`\n✅ Done. Inventory merges: ${merged}, variants deleted: ${deleted}, failed: ${failed}`);
}

run().catch(err => {
  console.error('❌ Fatal error:', err.message);
  process.exit(1);
});
