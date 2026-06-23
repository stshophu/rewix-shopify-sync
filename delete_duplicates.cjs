/**
 * Find products that share a SKU and delete all but one survivor per group.
 * Mirrors the matching key used by sync.js (buildSkuFor: code + size).
 *
 * SAFE BY DEFAULT: runs as a dry run unless --apply is passed.
 *
 * Usage:
 *   node delete_duplicates.cjs            ← dry run, prints what WOULD be deleted
 *   node delete_duplicates.cjs --apply    ← actually deletes
 */
require('dotenv').config();

const SHOPIFY_STORE = process.env.SHOPIFY_STORE;
const SHOPIFY_TOKEN = process.env.SHOPIFY_TOKEN;
const API_VERSION = '2024-01';
const DELAY_MS = 600;

const apply = process.argv.includes('--apply');

const base = () => `https://${SHOPIFY_STORE}/admin/api/${API_VERSION}`;
const headers = () => ({
  'Content-Type': 'application/json',
  'X-Shopify-Access-Token': SHOPIFY_TOKEN,
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);

// Survivor priority: prefer Active over Archived/Draft, then prefer the
// product with the lowest id (oldest / first created), since that's most
// likely the original, "real" listing that channels/catalogs are linked to.
function pickSurvivor(group) {
  const statusRank = { active: 0, draft: 1, archived: 2 };
  return [...group].sort((a, b) => {
    const ra = statusRank[a.status] ?? 3;
    const rb = statusRank[b.status] ?? 3;
    if (ra !== rb) return ra - rb;
    return a.id - b.id;
  })[0];
}

async function fetchAllProducts() {
  const products = [];
  let url = `${base()}/products.json?limit=250&fields=id,title,variants,status,created_at`;
  while (url) {
    const res = await fetch(url, { headers: headers() });
    if (!res.ok) throw new Error(`Fetch error: ${res.status}`);
    const data = await res.json();
    products.push(...(data.products || []));
    const link = res.headers.get('Link') || '';
    const next = link.match(/<([^>]+)>;\s*rel="next"/)?.[1];
    url = next || null;
    if (url) await sleep(DELAY_MS);
  }
  return products;
}

async function deleteProduct(id) {
  const res = await fetch(`${base()}/products/${id}.json`, {
    method: 'DELETE',
    headers: headers(),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    log(`  ❌ Failed to delete ${id}: ${JSON.stringify(err.errors || err)}`);
    return false;
  }
  return true;
}

async function run() {
  if (!SHOPIFY_STORE || !SHOPIFY_TOKEN) {
    console.error('Missing SHOPIFY_STORE / SHOPIFY_TOKEN env vars.');
    process.exit(1);
  }

  log(apply ? '⚠️  APPLY MODE — products will actually be deleted' : 'DRY RUN — nothing will be deleted, just reporting');
  log('Fetching all products…');
  const products = await fetchAllProducts();
  log(`Fetched ${products.length} products.`);

  // Group by every variant SKU. If two products share ANY sku, they're the
  // same group (handles partial overlaps from earlier matching bugs too).
  const skuToGroupKey = new Map(); // sku -> group representative id
  const groups = new Map(); // representative id -> Set of products

  for (const p of products) {
    const skus = (p.variants || []).map((v) => v.sku).filter(Boolean);
    if (skus.length === 0) continue;

    // Find if any SKU already belongs to an existing group
    let repId = null;
    for (const sku of skus) {
      if (skuToGroupKey.has(sku)) {
        repId = skuToGroupKey.get(sku);
        break;
      }
    }
    if (repId === null) repId = p.id; // start a new group, keyed by this product

    if (!groups.has(repId)) groups.set(repId, new Set());
    groups.get(repId).add(p);
    for (const sku of skus) skuToGroupKey.set(sku, repId);
  }

  const dupGroups = [...groups.values()].filter((g) => g.size > 1);
  log(`Found ${dupGroups.length} duplicate groups (${dupGroups.reduce((s, g) => s + g.size, 0)} products total in those groups).`);

  let totalToDelete = 0;
  for (const group of dupGroups) {
    const list = [...group];
    const survivor = pickSurvivor(list);
    const toDelete = list.filter((p) => p.id !== survivor.id);
    totalToDelete += toDelete.length;

    log(`\n📦 "${survivor.title}" — ${list.length} copies found`);
    log(`  ✅ KEEP    id=${survivor.id} status=${survivor.status} created=${survivor.created_at}`);
    for (const p of toDelete) {
      log(`  🗑️  ${apply ? 'DELETE' : 'WOULD DELETE'} id=${p.id} status=${p.status} created=${p.created_at}`);
      if (apply) {
        const ok = await deleteProduct(p.id);
        if (ok) log(`     done.`);
        await sleep(DELAY_MS);
      }
    }
  }

  log(`\n============================================================`);
  log(`Total products that ${apply ? 'were' : 'would be'} deleted: ${totalToDelete}`);
  if (!apply) {
    log(`This was a DRY RUN. Re-run with --apply to actually delete.`);
  }
}

run().catch((err) => {
  console.error('\n❌ Fatal error:', err.message);
  process.exit(1);
});
