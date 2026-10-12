/**
 * One-off: clear leftover "Hanau Warehouse" quantities on Rewix variants.
 *
 * When the sync removed Hanau from Rewix variants, Shopify kept the old
 * on-hand number on the (now inactive) Hanau level. It isn't sellable, but it
 * still shows in the admin and in inventory exports ("not fulfilled").
 * The API can't see those inactive levels, so the SKUs come from an inventory
 * export (hanau_reset_skus.txt, one SKU per line).
 *
 * Per SKU:
 *   - item must be stocked at 3169 Warehouse, otherwise it is skipped;
 *   - Hanau not active  -> inventoryActivate(onHand: 0), then inventoryDeactivate;
 *   - Hanau active at 0 -> inventoryDeactivate;
 *   - Hanau active with stock -> skipped and reported (never touched).
 *
 * Dry run by default. Pass --apply to write.
 */
require('dotenv').config();
const fs = require('fs');

const STORE   = process.env.SHOPIFY_STORE;
const TOKEN   = process.env.SHOPIFY_TOKEN;
const API     = '2026-01';
const APPLY   = process.argv.includes('--apply');
const HANAU   = 'gid://shopify/Location/99522380116';
const W3169   = 'gid://shopify/Location/113743003988';
const SKU_FILE = process.argv.find(a => a.endsWith('.txt')) || 'hanau_reset_skus.txt';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = m => console.log(`[${new Date().toISOString()}] ${m}`);

async function gql(query, variables = {}, attempt = 0) {
  const res = await fetch(`https://${STORE}/admin/api/${API}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': TOKEN },
    body: JSON.stringify({ query, variables }),
  });
  if (res.status === 429 || res.status >= 500) {
    if (attempt > 6) throw new Error(`HTTP ${res.status}`);
    await sleep(2000 * (attempt + 1));
    return gql(query, variables, attempt + 1);
  }
  const body = await res.json();
  if (body.errors?.some(e => e.extensions?.code === 'THROTTLED')) {
    if (attempt > 6) throw new Error('throttled');
    await sleep(2000 * (attempt + 1));
    return gql(query, variables, attempt + 1);
  }
  if (body.errors) throw new Error(JSON.stringify(body.errors));
  // Gentle pacing based on the cost bucket.
  const t = body.extensions?.cost?.throttleStatus;
  if (t && t.currentlyAvailable < 200) await sleep(1000);
  return body.data;
}

const LOOKUP = `query($q: String!) {
  productVariants(first: 100, query: $q) {
    nodes { sku inventoryItem { id inventoryLevels(first: 20) { nodes {
      id location { id } quantities(names: ["available","on_hand","committed"]) { name quantity } } } } }
  }
}`;
const ACTIVATE = `mutation($i: ID!, $l: ID!) {
  inventoryActivate(inventoryItemId: $i, locationId: $l, onHand: 0) {
    inventoryLevel { id } userErrors { field message } } }`;
const DEACTIVATE = `mutation($id: ID!) {
  inventoryDeactivate(inventoryLevelId: $id) { userErrors { field message } } }`;

async function run() {
  if (!STORE || !TOKEN) { console.error('Missing SHOPIFY_STORE / SHOPIFY_TOKEN'); process.exit(1); }
  const skus = fs.readFileSync(SKU_FILE, 'utf8').split('\n').map(s => s.trim()).filter(Boolean);
  log(`${skus.length} SKUs loaded from ${SKU_FILE} — ${APPLY ? 'APPLY' : 'DRY RUN'}`);

  const s = { reset: 0, deactivated: 0, notFound: 0, no3169: 0, hasStock: 0, failed: 0 };
  const report = [['sku', 'result', 'detail']];

  for (let i = 0; i < skus.length; i += 40) {
    const chunk = skus.slice(i, i + 40);
    const q = chunk.map(x => `sku:"${x.replace(/"/g, '\\"')}"`).join(' OR ');
    const data = await gql(LOOKUP, { q });
    const bySku = new Map();
    for (const v of data.productVariants.nodes) {
      if (!bySku.has(v.sku)) bySku.set(v.sku, []);
      bySku.get(v.sku).push(v);
    }

    for (const sku of chunk) {
      const variants = bySku.get(sku) || [];
      if (!variants.length) { s.notFound++; report.push([sku, 'not-found', '']); continue; }
      for (const v of variants) {
        const item = v.inventoryItem;
        const levels = item.inventoryLevels.nodes;
        if (!levels.some(l => l.location.id === W3169)) {
          s.no3169++; report.push([sku, 'skipped', 'not stocked at 3169']); continue;
        }
        const hanau = levels.find(l => l.location.id === HANAU);
        try {
          if (hanau) {
            const q2 = Object.fromEntries(hanau.quantities.map(x => [x.name, x.quantity]));
            if ((q2.on_hand || 0) !== 0 || (q2.committed || 0) !== 0) {
              s.hasStock++; report.push([sku, 'skipped', `active at Hanau with on_hand ${q2.on_hand}`]); continue;
            }
            if (APPLY) {
              const d = await gql(DEACTIVATE, { id: hanau.id });
              const e = d.inventoryDeactivate.userErrors; if (e.length) throw new Error(JSON.stringify(e));
            }
            s.deactivated++; report.push([sku, 'deactivated', 'was active at 0']);
          } else {
            if (APPLY) {
              const a = await gql(ACTIVATE, { i: item.id, l: HANAU });
              const ea = a.inventoryActivate.userErrors; if (ea.length) throw new Error(JSON.stringify(ea));
              const d = await gql(DEACTIVATE, { id: a.inventoryActivate.inventoryLevel.id });
              const ed = d.inventoryDeactivate.userErrors; if (ed.length) throw new Error(JSON.stringify(ed));
            }
            s.reset++; report.push([sku, 'reset', 'leftover cleared']);
          }
        } catch (err) {
          s.failed++; report.push([sku, 'failed', err.message.slice(0, 300)]);
        }
      }
    }
    log(`Progress ${Math.min(i + 40, skus.length)}/${skus.length} — ${JSON.stringify(s)}`);
  }

  fs.writeFileSync('hanau_reset_report.csv',
    report.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n'));
  log(`Done${APPLY ? '' : ' (DRY RUN — nothing changed)'}: ${JSON.stringify(s)}`);
}

run().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
