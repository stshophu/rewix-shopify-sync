/**
 * READ-ONLY preview of the RRP-based pricing in pricing.cjs.
 * Reads every RewixSync variant from Shopify (price, compare-at = RRP,
 * cost-per-item = Rewix cost, vendor) and writes:
 *   pricing_preview.csv          — one row per variant, old vs new
 *   pricing_preview_brands.csv   — per-brand summary
 * Changes nothing in Shopify.
 */
const fs = require('fs');
const { priceRewix } = require('./pricing.cjs');

const STORE = process.env.SHOPIFY_STORE;
const TOKEN = process.env.SHOPIFY_TOKEN;
if (!STORE || !TOKEN) { console.error('Missing SHOPIFY_STORE / SHOPIFY_TOKEN'); process.exit(1); }
const URL = `https://${STORE}/admin/api/2025-01/graphql.json`;

const Q = `query($after:String){ products(first:100, after:$after, query:"tag:RewixSync") {
  pageInfo { hasNextPage endCursor }
  nodes { id title vendor status tags
    variants(first:50){ nodes { sku price compareAtPrice inventoryQuantity inventoryItem { unitCost { amount } } } } } } }`;

async function gql(variables) {
  for (let a = 0; a < 8; a++) {
    const r = await fetch(URL, { method: 'POST', headers: { 'X-Shopify-Access-Token': TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: Q, variables }) });
    if (r.status === 429 || r.status >= 500) { await new Promise(s => setTimeout(s, 2000 * (a + 1))); continue; }
    const j = await r.json();
    if (j.errors) {
      if (JSON.stringify(j.errors).includes('THROTTLED')) { await new Promise(s => setTimeout(s, 3000)); continue; }
      throw new Error(JSON.stringify(j.errors));
    }
    return j.data;
  }
  throw new Error('Shopify GraphQL kept failing');
}

const csv = v => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

(async () => {
  const rows = [];
  let after = null;
  do {
    const d = await gql({ after });
    for (const p of d.products.nodes) {
      const isFabric = (p.tags || []).includes('fabric-brand') || /fabric/i.test(p.vendor || '');
      for (const v of p.variants.nodes) {
        const cost = parseFloat(v.inventoryItem?.unitCost?.amount);
        const rrp = v.compareAtPrice != null ? parseFloat(v.compareAtPrice) : null;
        const oldP = parseFloat(v.price);
        const { price: newP, reviewReason } = priceRewix({ cost, rrp, brand: p.vendor, isFabric });
        rows.push({ product: p.id.split('/').pop(), title: p.title, brand: p.vendor, status: p.status, sku: v.sku, stock: v.inventoryQuantity,
          cost, rrp, old: oldP, new: newP ?? '', oldOff: rrp ? Math.round((1 - oldP / rrp) * 100) : '', newOff: rrp && newP ? Math.round((1 - newP / rrp) * 100) : '',
          change: newP ? Math.round((newP - oldP) * 100) / 100 : '', flag: reviewReason || '' });
      }
    }
    after = d.products.pageInfo.hasNextPage ? d.products.pageInfo.endCursor : null;
    process.stdout.write(`\r${rows.length} variants…`);
  } while (after);
  console.log();

  const cols = Object.keys(rows[0]);
  fs.writeFileSync('pricing_preview.csv', [cols.join(','), ...rows.map(r => cols.map(c => csv(r[c])).join(','))].join('\n'));

  const by = {};
  for (const r of rows) {
    if (r.new === '') continue;
    const b = (by[r.brand] ||= { brand: r.brand, variants: 0, inStock: 0, oldSum: 0, newSum: 0, oldOff: 0, newOff: 0, n: 0, up: 0, down: 0 });
    b.variants++; if (r.stock > 0) b.inStock++;
    b.oldSum += r.old; b.newSum += r.new;
    if (r.rrp) { b.oldOff += r.oldOff; b.newOff += r.newOff; b.n++; }
    if (r.new > r.old + 0.005) b.up++; else if (r.new < r.old - 0.005) b.down++;
  }
  const brands = Object.values(by).sort((a, b) => b.variants - a.variants).map(b => ({
    brand: b.brand, variants: b.variants, inStock: b.inStock,
    avgOld: (b.oldSum / b.variants).toFixed(2), avgNew: (b.newSum / b.variants).toFixed(2),
    avgChangePct: ((b.newSum / b.oldSum - 1) * 100).toFixed(1),
    avgOffOld: b.n ? Math.round(b.oldOff / b.n) : '', avgOffNew: b.n ? Math.round(b.newOff / b.n) : '',
    up: b.up, down: b.down,
  }));
  const bc = Object.keys(brands[0]);
  fs.writeFileSync('pricing_preview_brands.csv', [bc.join(','), ...brands.map(r => bc.map(c => csv(r[c])).join(','))].join('\n'));

  const T = rows.filter(r => r.new !== '');
  const o = T.reduce((s, r) => s + r.old, 0), n = T.reduce((s, r) => s + r.new, 0);
  console.log(`Variants: ${rows.length} | priced: ${T.length} | up: ${T.filter(r => r.new > r.old + 0.005).length} | down: ${T.filter(r => r.new < r.old - 0.005).length} | avg price change: ${((n / o - 1) * 100).toFixed(1)} %`);
  console.log('Flags:', JSON.stringify(rows.reduce((a, r) => (r.flag && (a[r.flag] = (a[r.flag] || 0) + 1), a), {})));
  console.log('\nTop brands:');
  for (const b of brands.slice(0, 40)) console.log(`${b.brand.padEnd(26)} ${String(b.variants).padStart(5)}  avg €${b.avgOld} → €${b.avgNew} (${b.avgChangePct} %)  off ${b.avgOffOld}% → ${b.avgOffNew}%  down:${b.down}`);
})().catch(e => { console.error(e); process.exit(1); });
