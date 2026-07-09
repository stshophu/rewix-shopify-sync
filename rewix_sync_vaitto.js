/**
 * Rewix → Vaitto  (Romanelli / EU-WAR-1)
 * Env vars: REWIX_BASE_URL, REWIX_API_KEY, REWIX_PASSWORD, REWIX_IMAGE_BASE,
 *           VAITTO_SUPABASE_URL, VAITTO_SUPABASE_SERVICE_KEY, VAITTO_DRY_RUN
 * Usage: node rewix_sync_vaitto.js [--full]
 */
require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const repoPath = process.env.REWIX_REPO_PATH || __dirname;
const { buildTitle, translateCategory, translateSubcategory,
        normalizeSeason, normalizeGender } = require(path.join(repoPath, 'translate.cjs'));

const SUPPLIER_ID = '34e860f0-67ac-48b7-9df9-a16043e8bede';
const SB_URL      = (process.env.VAITTO_SUPABASE_URL || '').replace(/\/$/, '');

// ── Taxonomy maps (subcategory string → Vaitto UUID) ──────────────────────────
const CATEGORY_IDS = {
  'Clothing':'7ce80cf0-8abc-4012-9856-4ae3577010a8','Shoes':'269335d1-6456-4877-a212-76828272dc2f',
  'Bags':'50cd953d-522d-4c50-b87b-915a05f1022d','Accessories':'9f1faf56-7d36-443f-8366-c2c5e4512091',
  'Jewelry':'4516c76f-cab0-4cb1-814c-3cfbf06f3618',
};
const SUBCATEGORY_IDS = {
  'Jackets':'0f6e4894-6090-492a-a85b-fee97f92a613','Dresses':'d4e7d2fc-d19b-4e73-a9ad-a39e9025eb3e',
  'Pants':'043e7edb-ad1f-4fbb-864c-65337b529de4','Jeans':'176f5878-c75b-4a3d-aa0b-726b5ea206d8',
  'Shorts':'4020d90c-5170-4fb5-a981-717d6caf10b5','Skirts':'458e612c-2ee2-4601-969e-7e71e5c4c7bf',
  'Knitwear':'bd6e5b49-856c-455f-b76c-5b39e176ebf9','Shirts':'0a680369-7ae0-4983-920b-4c38160a7ac0',
  'Polos':'ccb98e23-83eb-46da-9526-51c29a056e18','T-shirts & Tops':'32395cab-4119-4ea7-a2d3-3f5336e8ee02',
  'Hoodies':'ed48dd16-5597-445a-9add-7a1c7f954370','Vests':'4179dd83-8188-4d76-82f6-0d6f1469c2aa',
  'Jumpsuits':'124e8c0c-e4c3-45ee-a5a0-7963c3f68e62','Swimwear':'e58b92c6-4428-495f-add1-c303304204df',
  'Underwear':'a281a0ca-2ee6-4eaa-a165-4140a272cf25','Sneakers':'513c68b5-500f-4cf8-9264-bb09585e0cb3',
  'Boots':'20320b52-d447-45b8-b0fa-76e6fe07d9c4','Sandals':'45c7fd13-ac78-401b-a568-126bfdfd9d44',
  'Loafers':'10d127ea-355f-45fe-a1c4-1ebc143dcb30','Heels':'a3193738-36b8-4b69-9b7d-a8b2acc315af',
  'Flats':'63602cf1-3319-459d-8eb9-ed0c7cfee9d4','Handbags':'d4a89c3c-b34b-4f82-bb9b-5aa4b7d2601c',
  'Shoulder':'b830bdc6-8a30-42c8-a644-843c8334b4ea','Crossbody':'4aeb3988-0ce5-4101-9d0b-eced6a03c302',
  'Clutch':'890e080d-8c38-4d92-aca3-5628bd35edf9','Tote':'d93894cb-2a5e-4667-a653-37fe780204b5',
  'Backpack':'da0dcaa9-4de3-487b-a1d2-baf742287826','Wallet':'30dfb52f-7eb5-4ce7-934b-dd4c89bd2a68',
  'Belts':'906516f9-d89e-4956-aba7-cd561592292d','Scarves':'a16f281a-091d-43c6-90b5-f9be8f5e173a',
  'Hats':'772c481c-c206-4f72-880e-8dedfae9638c','Gloves':'a151dc72-a632-409c-ae0b-14f1f5a414e0',
  'Sunglasses':'ceeb4d72-9a9c-4220-a512-387933f85dce','Ties':'cb768e82-72c0-4974-addd-f83dc153e5cc',
  'Bracelets':'d6ccd8a5-6c9e-4b1f-83e9-966013ba088e','Earrings':'2dc9e53a-c598-4cb2-9d00-f06394a5d261',
  'Rings':'687a9fd7-8c10-4416-9328-789e859fcaff','Necklaces':'7856327d-3ea0-45a0-99aa-7f24bbdbe2d0',
  'Watches':'cd2ac6a4-d024-4225-97f8-ceaf8d3d1547',
};
const CAT_MAP = {
  'sneakers':'Shoes','boots':'Shoes','sandals':'Shoes','loafers':'Shoes','heels':'Shoes','flats':'Shoes',
  'bags':'Bags','handbags':'Bags','tote bags':'Bags','clutches':'Bags','backpacks':'Bags',
  'crossbody bags':'Bags','shoulder bags':'Bags',
  'jewelry':'Jewelry','bracelets':'Jewelry','earrings':'Jewelry','rings':'Jewelry','necklaces':'Jewelry',
  'watches':'Accessories','belts':'Accessories','scarves':'Accessories','hats':'Accessories',
  'gloves':'Accessories','sunglasses':'Accessories','ties':'Accessories','wallets':'Accessories',
};
const SUB_MAP = {
  'jackets':'Jackets','coats':'Jackets','trench coats':'Jackets','down jackets':'Jackets','blazer':'Jackets',
  'dresses':'Dresses','pants':'Pants','trousers':'Pants','jeans':'Jeans','shorts':'Shorts',
  'skirts':'Skirts','knitwear':'Knitwear','sweaters':'Knitwear','cardigans':'Knitwear',
  'shirts':'Shirts','polos':'Polos','t-shirts & tops':'T-shirts & Tops','t-shirts':'T-shirts & Tops',
  'tops':'T-shirts & Tops','hoodies':'Hoodies','vests':'Vests','jumpsuits':'Jumpsuits',
  'swimwear':'Swimwear','underwear':'Underwear','sneakers':'Sneakers','boots':'Boots',
  'ankle boots':'Boots','sandals':'Sandals','loafers':'Loafers','heels':'Heels','flats':'Flats',
  'handbags':'Handbags','shoulder bags':'Shoulder','crossbody bags':'Crossbody',
  'clutches':'Clutch','tote bags':'Tote','backpacks':'Backpack','wallets':'Wallet',
  'belts':'Belts','scarves':'Scarves','hats':'Hats','gloves':'Gloves',
  'sunglasses':'Sunglasses','ties':'Ties','bracelets':'Bracelets','earrings':'Earrings',
  'rings':'Rings','necklaces':'Necklaces','watches':'Watches',
};
const GENDER_MAP = {
  'men':'Men','man':'Men','uomo':'Men','women':'Women','woman':'Women','donna':'Women',
  'unisex':'Unisex','kids':'Kids','junior':'Kids',
};

// Brand cache loaded at start
let _brands = new Map(); // name.lower → uuid
let _unknownBrandId = null;

async function loadBrands() {
  const r = await sbReq('GET', 'brands', { params: { select: 'id,name', limit: '2000' } });
  if (r?.ok) {
    const rows = await r.json();
    for (const row of rows) {
      _brands.set(row.name.trim().toLowerCase(), row.id);
      if (row.name.trim().toLowerCase() === 'unknown') _unknownBrandId = row.id;
    }
  }
  return _brands;
}

function resolveBrand(name) {
  if (!name) return _unknownBrandId;
  return _brands.get(name.trim().toLowerCase()) || _unknownBrandId;
}
function resolveCategory(subcat) {
  if (!subcat) return null;
  const k = subcat.trim().toLowerCase();
  const cat = CAT_MAP[k] || (k.includes('shoe')||k.includes('boot')||k.includes('sneak') ? 'Shoes'
    : k.includes('bag')||k.includes('clutch')||k.includes('tote') ? 'Bags'
    : k.includes('jewel')||k.includes('earring')||k.includes('bracelet') ? 'Jewelry'
    : 'Clothing');
  return CATEGORY_IDS[cat] || null;
}
function resolveSubcategory(subcat) {
  if (!subcat) return null;
  const k = subcat.trim().toLowerCase();
  const name = SUB_MAP[k];
  return name ? SUBCATEGORY_IDS[name] : null;
}
function resolveGender(raw) {
  if (!raw) return null;
  return GENDER_MAP[raw.trim().toLowerCase()] || null;
}
const SB_KEY      = process.env.VAITTO_SUPABASE_SERVICE_KEY || '';
const DRY_RUN     = process.env.VAITTO_DRY_RUN === '1';
const REWIX_BASE  = process.env.REWIX_BASE_URL;
const REWIX_IMG   = process.env.REWIX_IMAGE_BASE || REWIX_BASE;
const LAST_FILE   = path.join(__dirname, '.rewix_vaitto_last_sync');
const LOCALES     = 'en_US,de_DE';

if (!SB_URL || !SB_KEY) { console.error('Missing Supabase env vars'); process.exit(1); }

const log  = m => console.log(`[${new Date().toISOString()}] ${m}`);
const warn = m => console.warn(`[${new Date().toISOString()}] ⚠  ${m}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const basicAuth = () => Buffer.from(`${process.env.REWIX_API_KEY}:${process.env.REWIX_PASSWORD}`).toString('base64');

// ── Supabase ───────────────────────────────────────────────────────────────────
const sbH = () => ({ 'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}`,
                     'Content-Type': 'application/json', 'Prefer': 'return=minimal' });

async function sbReq(method, table, { params = {}, body = null, prefer = 'return=minimal' } = {}) {
  const url = new URL(`${SB_URL}/rest/v1/${table}`);
  Object.entries(params).forEach(([k,v]) => url.searchParams.set(k, v));
  for (let i = 0; i < 4; i++) {
    try {
      const res = await fetch(url.toString(), {
        method, headers: { ...sbH(), Prefer: prefer },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status === 429) { await sleep(parseFloat(res.headers.get('Retry-After')||'5')*1000); continue; }
      if (res.status >= 500)  { await sleep(2**i*1000); continue; }
      return res;
    } catch(e) { await sleep(2**i*1000); }
  }
  return null;
}

// ── Load existing ──────────────────────────────────────────────────────────────
async function loadExisting() {
  const r = await sbReq('GET', 'products', { params: { supplier_id: `eq.${SUPPLIER_ID}`, select: 'id,vaitto_sku', limit: '10000' } });
  if (!r?.ok) { warn('Could not load existing products'); return new Map(); }
  const rows = await r.json();
  return new Map(rows.filter(r => r.vaitto_sku).map(r => [r.vaitto_sku, r.id]));
}

// ── Rewix fetch ────────────────────────────────────────────────────────────────
async function fetchRewix(since) {
  const params = new URLSearchParams({ v: 'TEAL', acceptedlocales: LOCALES });
  if (since) {
    if (Date.now() - new Date(since).getTime() > 3.5*60*60*1000) { since = null; log('Timestamp too old — full sync'); }
    else params.set('since', since);
  }
  const url = `${REWIX_BASE}/restful/export/api/products.json?${params}`;
  log(`Fetching Rewix${since ? ` (since ${since})` : ' (full)'}…`);
  for (let i = 0; i < 4; i++) {
    try {
      const res = await fetch(url, { headers: { Authorization: `Basic ${basicAuth()}`, Accept: 'application/json' }, signal: AbortSignal.timeout(120_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      log(`Rewix: ${data.pageItems?.length ?? 0} products`);
      return data;
    } catch(e) { if (i===3) throw e; await sleep(Math.min(2**(i+1)*1000,30_000)); }
  }
}

// ── Parse helpers ──────────────────────────────────────────────────────────────
const tagEN = (tags, key) => { const t = tags?.find(t=>t.name===key); const l = t?.localizations?.find(l=>l.locale==='en_US')||t?.localizations?.[0]; return l?.value||null; };
const localized = (locs, f) => { const l = locs?.find(l=>l.locale==='en_US')||locs?.[0]; return l?.[f]||''; };
const buildSku = m => { const c=(m.code||'').trim(); const s=(m.size||'').trim(); return s?`${c}-${s}`:c; };

function parseProduct(rp) {
  const brand    = tagEN(rp.tags,'brand')||'';
  const catRaw   = tagEN(rp.tags,'category')||'';
  const subRaw   = tagEN(rp.tags,'subcategory')||'';
  const gender   = normalizeGender(tagEN(rp.tags,'gender')||'');
  const color    = tagEN(rp.tags,'color')||'';
  const subcat   = translateSubcategory(subRaw);
  const category = subcat || translateCategory(catRaw) || null;
  const title    = buildTitle({ brand, gender, name: rp.name, color, subcat })
                || localized(rp.productLocalizations,'productName') || rp.name;
  const desc     = localized(rp.productLocalizations,'description') || null;
  const images   = (rp.images||[]).map(img => img.url.startsWith('http') ? img.url : `${REWIX_IMG}${img.url}`);

  // Dedupe models by SKU, sum stock
  const seen = new Map();
  for (const m of rp.models||[]) {
    const sku = buildSku(m);
    if (!seen.has(sku)) seen.set(sku, {...m});
    else seen.get(sku).availability = (seen.get(sku).availability||0) + (m.availability||0);
  }
  const models    = [...seen.values()];
  const stockQty  = models.reduce((s,m) => s + (parseInt(m.availability||0)), 0);
  const ref       = models.find(m => (m.availability||0) > 0) || models[0] || {};
  const cost      = ref.taxable != null ? parseFloat(ref.taxable) : null;
  const rrp       = ref.streetPrice != null ? parseFloat(ref.streetPrice) : null;
  const productSku = (models[0]?.code||'').trim() || String(rp.id);

  const categoryId    = resolveCategory(subcat || category);
  const subcategoryId = resolveSubcategory(subcat || category);
  const genderResolved = resolveGender(gender);
  const brandId = resolveBrand(brand);
  return { productSku, title, desc, categoryId, subcategoryId, genderResolved, brandId, cost, rrp, stockQty, images };
}

// ── Main ───────────────────────────────────────────────────────────────────────
async function main() {
  log('═'.repeat(50));
  log(`🚀  Rewix → Vaitto  ${new Date().toISOString()}`);
  if (DRY_RUN) log('  [DRY RUN]');

  const full  = process.argv.includes('--full');
  const since = !full && fs.existsSync(LAST_FILE) ? fs.readFileSync(LAST_FILE,'utf8').trim() : null;
  const cursor = new Date(Date.now() - 15*60*1000).toISOString();

  const data     = await fetchRewix(since);
  const products = data.pageItems || [];
  if (!products.length) { log('Nothing to sync'); fs.writeFileSync(LAST_FILE, cursor); return; }

  await loadBrands();
  log(`  ${_brands.size} brands loaded`);
  const existing = await loadExisting();
  log(`  ${existing.size} existing products`);

  const counts = { created:0, updated:0, deactivated:0, skipped:0, errors:0 };

  for (let i = 0; i < products.length; i++) {
    const rp = products[i];
    let parsed;
    try { parsed = parseProduct(rp); } catch(e) { warn(`Parse error ${rp.id}: ${e.message}`); counts.errors++; continue; }
    const { productSku, title, desc, categoryId, subcategoryId, genderResolved, brandId, cost, rrp, stockQty, images } = parsed;
    const isNew = !existing.has(productSku);
    log(`[${i+1}/${products.length}]  ${productSku}  '${title}'  stock=${stockQty}`);

    if (isNew && stockQty === 0) { counts.skipped++; continue; }

    if (!isNew && stockQty === 0) {
      if (!DRY_RUN) await sbReq('PATCH','products',{ params:{id:`eq.${existing.get(productSku)}`}, body:{active:false,stock_qty:0} });
      log(`  🔴 DEACTIVATED`); counts.deactivated++; continue;
    }

    const slug = `${SUPPLIER_ID.slice(0,8)}-${productSku}`.toLowerCase().replace(/\s+/g,'-').slice(0,200);
    const body = {
      supplier_id: SUPPLIER_ID, brand_id: brandId, vaitto_sku: productSku,
      name: title, slug, category_id: categoryId, subcategory_id: subcategoryId,
      gender: genderResolved, description: desc||'',
      supplier_price: cost ? Math.round(cost*100)/100 : null,
      rrp:  rrp  ? Math.round(rrp*100)/100  : null,
      stock_qty: stockQty, active: true, dropship_available: true,
      image_url: images[0]||null,
      images: images.slice(0,10).map(u=>({url:u})),
    };

    if (DRY_RUN) { log(`  [DRY RUN] ${isNew?'CREATE':'UPDATE'}`); continue; }

    if (isNew) {
      const r = await sbReq('POST','products',{ body, prefer:'return=representation' });
      if (r?.ok) { const d=await r.json(); existing.set(productSku,(Array.isArray(d)?d[0]:d).id); log(`  ✅ CREATED`); counts.created++; }
      else { warn(`CREATE failed: ${r?.status}`); counts.errors++; }
    } else {
      const { slug:_s, vaitto_sku:_v, ...upd } = body;
      const r = await sbReq('PATCH','products',{ params:{id:`eq.${existing.get(productSku)}`}, body:upd });
      if (r && [200,204].includes(r.status)) { log(`  🔄 UPDATED`); counts.updated++; }
      else { warn(`UPDATE failed: ${r?.status}`); counts.errors++; }
    }
    await sleep(80);
  }

  if (!DRY_RUN) fs.writeFileSync(LAST_FILE, cursor);
  log(`\n  ✅${counts.created} created  🔄${counts.updated} updated  🔴${counts.deactivated} deactivated  ⏭${counts.skipped} skipped  ❌${counts.errors} errors`);
  log('═'.repeat(50));
}

main().catch(e => { console.error(e); process.exit(1); });
