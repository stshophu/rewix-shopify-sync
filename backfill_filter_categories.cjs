/**
 * One-off: fill the storefront filter fields (filter.category / filter.subcategory)
 * on active products that have neither.
 *
 *   - only products where BOTH fields are empty are touched;
 *   - values come from rewix.subcategory, product type, tags or title and are
 *     restricted to the values that already exist in the shop (filter-taxonomy.cjs);
 *   - anything that cannot be placed is left empty and listed in the report.
 *
 * Dry run by default. Pass --apply to write.
 * Output: backfill_filter_report.csv (+ summary in the log).
 */
require('dotenv').config();
const fs = require('fs');
const { classify } = require('./filter-taxonomy.cjs');

const STORE = process.env.SHOPIFY_STORE;
const TOKEN = process.env.SHOPIFY_TOKEN;
const API   = '2026-01';
const APPLY = process.argv.includes('--apply');
const ONLY_IN_STOCK = !process.argv.includes('--all');

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
  const t = body.extensions?.cost?.throttleStatus;
  if (t && t.currentlyAvailable < 300) await sleep(1000);
  return body.data;
}

const Q = `query($q: String!, $after: String) {
  products(first: 100, query: $q, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id title productType tags
      rs: metafield(namespace: "rewix", key: "subcategory") { value }
      fc: metafield(namespace: "filter", key: "category") { value }
      fs: metafield(namespace: "filter", key: "subcategory") { value }
    }
  }
}`;

const SET = `mutation($m: [MetafieldsSetInput!]!) {
  metafieldsSet(metafields: $m) { userErrors { field message code } }
}`;

const csv = v => `"${String(v ?? '').replace(/"/g, '""')}"`;

(async () => {
  for (const k of ['SHOPIFY_STORE', 'SHOPIFY_TOKEN']) if (!process.env[k]) throw new Error(`${k} missing`);
  const q = 'status:active AND -metafields.filter.category:*' + (ONLY_IN_STOCK ? ' AND inventory_total:>0' : '');
  log(`${APPLY ? 'APPLY' : 'DRY RUN'} — query: ${q}`);

  const rows = [];
  let after = null;
  do {
    const d = await gql(Q, { q, after });
    for (const p of d.products.nodes) {
      if (p.fc?.value || p.fs?.value) continue; // never overwrite anything
      const r = classify({ productType: p.productType, title: p.title, tags: p.tags, rewixSub: p.rs?.value });
      rows.push({ id: p.id, title: p.title, productType: p.productType, ...r });
    }
    after = d.products.pageInfo.hasNextPage ? d.products.pageInfo.endCursor : null;
  } while (after);
  log(`candidates: ${rows.length}`);

  // report
  const report = ['product_id,title,product_type,category,subcategory,source'];
  for (const r of rows) report.push([r.id, r.title, r.productType, r.category, r.subcategory, r.source].map(csv).join(','));
  fs.writeFileSync('backfill_filter_report.csv', report.join('\n'));

  const byPair = {};
  let both = 0, catOnly = 0, none = 0;
  for (const r of rows) {
    if (r.category && r.subcategory) both++; else if (r.category) catOnly++; else none++;
    const k = `${r.category || '-'} / ${r.subcategory || '-'}`;
    byPair[k] = (byPair[k] || 0) + 1;
  }
  log(`category+subcategory: ${both} | category only: ${catOnly} | unplaced: ${none}`);
  for (const [k, n] of Object.entries(byPair).sort((a, b) => b[1] - a[1])) log(`  ${String(n).padStart(4)}  ${k}`);
  const unplaced = rows.filter(r => !r.category || !r.subcategory).slice(0, 40);
  if (unplaced.length) {
    log('examples not fully placed (productType | title):');
    for (const r of unplaced) log(`  [${r.category || '-'}/${r.subcategory || '-'}] ${r.productType} | ${r.title}`);
  }

  if (!APPLY) { log('dry run — nothing written. Re-run with apply to write.'); return; }

  const inputs = [];
  for (const r of rows) {
    if (r.category) inputs.push({ ownerId: r.id, namespace: 'filter', key: 'category', type: 'single_line_text_field', value: r.category });
    if (r.subcategory) inputs.push({ ownerId: r.id, namespace: 'filter', key: 'subcategory', type: 'single_line_text_field', value: r.subcategory });
  }
  let done = 0, errs = 0;
  for (let i = 0; i < inputs.length; i += 25) {
    const d = await gql(SET, { m: inputs.slice(i, i + 25) });
    const ue = d.metafieldsSet.userErrors || [];
    if (ue.length) { errs += ue.length; log(`  errors: ${JSON.stringify(ue).slice(0, 300)}`); }
    done += Math.min(25, inputs.length - i);
    if ((i / 25) % 10 === 0) log(`  written ${done}/${inputs.length}`);
  }
  log(`done — ${done} metafields written, ${errs} errors`);
})().catch(e => { console.error(e); process.exit(1); });
