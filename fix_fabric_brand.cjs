/**
 * One-off: rename existing "Loro Piana Fabric"-type products so they are not
 * sold under the mill's name (Google misrepresentation). For every match:
 *   - title       "Loro Piana Fabric Man Coat Black" -> "Man Coat Black, made with Loro Piana fabric"
 *   - description  note prepended: made by an independent manufacturer, not a Loro Piana product
 *   - vendor      "<Mill> Fabric"
 *   - SEO title   same as the new title
 *   - tags        + fabric-brand, no-google
 * Covers all suppliers (Rewix, LH8, ...). Genuine Loro Piana products are left alone.
 *
 *   node fix_fabric_brand.cjs           # dry run — lists what would change
 *   node fix_fabric_brand.cjs --apply   # applies
 */
const { fabricMill, fabricTitle, fabricBody, FABRIC_TAG, NO_GOOGLE_TAG } = require('./fabric-brand.cjs');

const STORE = process.env.SHOPIFY_STORE;
const TOKEN = process.env.SHOPIFY_TOKEN;
const APPLY = process.argv.includes('--apply');
const URL = `https://${STORE}/admin/api/2024-10/graphql.json`;
const SEARCH = [
  "vendor:'Loro Piana Fabric'", "vendor:'L.P. Fabric'", "vendor:'Loro Piana tessuto'",
  "vendor:'loro piana tessuto'", "vendor:'Ermenegildo Zegna Fabric'", "vendor:'Loro Piana'",
  "title:*Fabric*", "title:*Tessuto*", "tag:'loro piana tessuto'",
].join(' OR ');

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function gql(query, variables = {}) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const res = await fetch(URL, {
      method: 'POST',
      headers: { 'X-Shopify-Access-Token': TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
    if (res.status === 429 || res.status >= 500) { await sleep(1000 * 2 ** attempt); continue; }
    const data = await res.json();
    if ((data.errors || []).some(e => e.extensions?.code === 'THROTTLED')) { await sleep(1000 * 2 ** attempt); continue; }
    if (data.errors) throw new Error(JSON.stringify(data.errors));
    return data.data;
  }
  throw new Error('Shopify kept throttling');
}

const SCAN = `query($after: String, $q: String) {
  products(first: 100, after: $after, query: $q) {
    pageInfo { hasNextPage endCursor }
    nodes { id title vendor tags descriptionHtml status }
  }
}`;

const UPDATE = `mutation($input: ProductInput!) {
  productUpdate(input: $input) { product { id } userErrors { field message } }
}`;

(async () => {
  if (!STORE || !TOKEN) { console.error('SHOPIFY_STORE / SHOPIFY_TOKEN missing'); process.exit(1); }
  const todo = [];
  let after = null, scanned = 0;
  do {
    const page = (await gql(SCAN, { after, q: SEARCH })).products;
    for (const p of page.nodes) {
      scanned++;
      const mill = fabricMill(p.vendor, { title: p.title, tags: p.tags });
      if (!mill) continue;
      const title = fabricTitle(p.title, mill);
      const body = fabricBody(p.descriptionHtml, mill);
      const vendor = `${mill} Fabric`;
      const tags = [...new Set([...p.tags, FABRIC_TAG, NO_GOOGLE_TAG])];
      if (title === p.title && body === p.descriptionHtml && vendor === p.vendor &&
          tags.length === p.tags.length) continue;
      todo.push({ p, title, body, vendor, tags });
    }
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);

  console.log(`Scanned ${scanned} candidates; ${todo.length} fabric-brand products to fix`);
  for (const t of todo.slice(0, 15)) console.log(`  ${t.p.status}  "${t.p.title}"  ->  "${t.title}"`);
  if (!APPLY) { console.log('Dry run — nothing changed. Re-run with --apply.'); return; }

  let errors = 0;
  for (const [i, t] of todo.entries()) {
    const r = (await gql(UPDATE, { input: {
      id: t.p.id, title: t.title, descriptionHtml: t.body, vendor: t.vendor,
      tags: t.tags, seo: { title: t.title },
    } })).productUpdate;
    if (r.userErrors.length) { errors++; console.log('ERROR', t.p.title, JSON.stringify(r.userErrors)); }
    if ((i + 1) % 50 === 0) console.log(`  ${i + 1}/${todo.length} done`);
  }
  console.log(`Updated ${todo.length - errors} products (${errors} errors).`);
})().catch(e => { console.error(e); process.exit(1); });
