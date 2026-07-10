/**
 * Rewix → Vaitto  (Romanelli / EU-WAR-1)
 * Uses direct Postgres connection via pg library — no Supabase REST.
 *
 * Env vars: REWIX_BASE_URL, REWIX_API_KEY, REWIX_PASSWORD, REWIX_IMAGE_BASE,
 *           VAITTO_DB_URL, VAITTO_DRY_RUN
 * Usage: node rewix_sync_vaitto.js [--full]
 */
require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const { Client } = require('pg');

const repoPath = process.env.REWIX_REPO_PATH || __dirname;
const { buildTitle, translateCategory, translateSubcategory,
        normalizeSeason, normalizeGender } = require(path.join(repoPath, 'translate.cjs'));

const SUPPLIER_ID = '34e860f0-67ac-48b7-9df9-a16043e8bede';
const DB_URL      = process.env.VAITTO_DB_URL;
const DRY_RUN     = process.env.VAITTO_DRY_RUN === '1';
const REWIX_BASE  = process.env.REWIX_BASE_URL;
const REWIX_IMG   = process.env.REWIX_IMAGE_BASE || REWIX_BASE;
const LAST_FILE   = path.join(__dirname, '.rewix_vaitto_last_sync');
const LOCALES     = 'en_US,de_DE';

if (!DB_URL) { console.error('Missing VAITTO_DB_URL'); process.exit(1); }

const log  = m => console.log(`[${new Date().toISOString()}] ${m}`);
const warn = m => console.warn(`[${new Date().toISOString()}] ⚠  ${m}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const basicAuth = () => Buffer.from(`${process.env.REWIX_API_KEY}:${process.env.REWIX_PASSWORD}`).toString('base64');

// ── Taxonomy maps ──────────────────────────────────────────────────────────────
const CATEGORY_IDS = {
  'Clothing':'9ad0fa3b-6630-4191-ad42-833a3416fde0','Shoes':'99f535ee-1331-4cb5-b963-2d831d13ef92',
  'Bags':'ff381def-e899-4964-92db-8e7c25c2a7fc','Accessories':'56e164a3-7815-4436-bf92-f3399b4047a4',
  'Jewelry':'eff88827-38ad-4d6e-a693-56a66650ee43',
};
const SUBCATEGORY_IDS = {
  'Jackets':'4a128ad6-cfaf-466c-a75d-d1b975115569','Dresses':'47c51da6-f98b-4241-a09a-8f32e955ae05',
  'Pants':'a2d88207-e237-44ee-add0-b3978537fc57','Jeans':'6c8b8116-f5fa-48f5-a8da-1cfab2cfcb69',
  'Shorts':'0abb7d0f-ac23-4e79-b5c6-cff8fe6a41d6','Skirts':'a2a34f28-96fa-4b2f-8c45-35a9d3cfd072',
  'Knitwear':'94546098-d2dc-425d-b58c-5d8f5fa9a3c3','Shirts':'40e0597d-2017-4f0a-866f-c9971f9e2cb6',
  'Polos':'33d34d41-bea6-4667-923e-288dd53fb6da','T-shirts & Tops':'3f93efc4-2383-48af-8fe7-6baf63fc6bb0',
  'Hoodies':'20e9220b-8eda-4785-a6bb-20166fe29202','Vests':'7cb3e006-8e2c-42ee-947a-93fd52c84565',
  'Jumpsuits':'c8bad908-dad9-4a83-976b-e56f138e80a2','Swimwear':'6c874f0b-8a1c-49d1-acf4-65c39335329b',
  'Underwear':'7d2fb1b0-e7d2-4286-9746-bc9f9be41d1d','Sneakers':'72748281-5d72-44ae-8808-85d022aa2a64',
  'Boots':'3da4e73b-65dc-411f-a72b-84333c5b7ca1','Sandals':'8ba79a40-73ea-4075-9a95-61cd15c59c45',
  'Loafers':'645bb508-d7a5-4e19-8878-7bc91fadbbb7','Heels':'d9d5b2f8-9ae6-4395-9b74-50ed2ec876b8',
  'Flats':'cedfb795-4b57-40e2-96dd-dc1bcdb80421','Handbags':'5dcc7f6b-1501-4f64-b889-187300cc79c8',
  'Shoulder':'38e359f4-8322-40bf-a73b-28cdaf306627','Crossbody':'f4522ac4-6199-48de-a498-f0cf9e6ea484',
  'Clutch':'8f5d0136-1bf9-47f7-8b62-d80ad0e52b50','Tote':'16398e34-45d4-4df6-aabe-fe79c50665d1',
  'Backpack':'cc5a9482-cd7b-41bf-aec9-effc00d69993','Wallet':'68e60a05-8d28-4f80-9975-db5d053712e8',
  'Belts':'2c8fa9f9-f8ea-4f07-bfbd-cd4801017f91','Scarves':'f4f3316e-7f29-4941-afd8-2bb81b161601',
  'Hats':'7d1822e7-ff8b-4da4-9c6c-56e900e69e44','Gloves':'eaf4598f-447b-49c5-83cf-0c42c317c899',
  'Sunglasses':'6a817ca7-fc74-4333-8a2b-0397ba885b33','Ties':'1f5a66ad-7d67-43c2-9d66-68b7a56335dc',
  'Bracelets':'a601ef62-39d2-4541-a5ab-55264b53440d','Earrings':'0a796024-5aad-4a98-a8a9-291481b1ea94',
  'Rings':'8deb498c-0e2e-4597-beec-77fc11ead436','Necklaces':'6da8eff6-1f4a-4ce1-ace9-1deb50708ab3',
  'Watches':'c39b5dc5-9280-421c-9f16-a43831887111',
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

function resolveCategory(subcat) {
  if (!subcat) return null;
  const k = subcat.trim().toLowerCase();
  const cat = CAT_MAP[k] || (
    k.includes('shoe')||k.includes('boot')||k.includes('sneak') ? 'Shoes' :
    k.includes('bag')||k.includes('clutch')||k.includes('tote') ? 'Bags' :
    k.includes('jewel')||k.includes('earring')||k.includes('bracelet') ? 'Jewelry' :
    'Clothing');
  return CATEGORY_IDS[cat] || null;
}
function resolveSubcategory(subcat) {
  if (!subcat) return null;
  const name = SUB_MAP[subcat.trim().toLowerCase()];
  return name ? SUBCATEGORY_IDS[name] : null;
}
function resolveGender(raw) {
  if (!raw) return null;
  return GENDER_MAP[raw.trim().toLowerCase()] || null;
}

// ── DB helpers ─────────────────────────────────────────────────────────────────
async function loadExisting(db) {
  const res = await db.query(
    "SELECT id, vaitto_sku FROM products WHERE supplier_id = $1 AND vaitto_sku IS NOT NULL",
    [SUPPLIER_ID]
  );
  return new Map(res.rows.map(r => [r.vaitto_sku, r.id]));
}

async function loadBrands(db) {
  const res = await db.query("SELECT id, name FROM brands WHERE active = true");
  const map = new Map();
  let unknownId = null;
  for (const r of res.rows) {
    map.set(r.name.trim().toLowerCase(), r.id);
    if (r.name.trim().toLowerCase() === 'unknown') unknownId = r.id;
  }
  return { map, unknownId };
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
      const res = await fetch(url, {
        headers: { Authorization: `Basic ${basicAuth()}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(120_000),
      });
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

function parseProduct(rp, brandMap, unknownBrandId) {
  const brand    = tagEN(rp.tags,'brand')||'';
  const catRaw   = tagEN(rp.tags,'category')||'';
  const subRaw   = tagEN(rp.tags,'subcategory')||'';
  const gender   = resolveGender(tagEN(rp.tags,'gender')||'');
  const color    = tagEN(rp.tags,'color')||'';
  const subcat   = translateSubcategory(subRaw);
  const title    = buildTitle({ brand, gender, name: rp.name, color, subcat })
                || localized(rp.productLocalizations,'productName') || rp.name;
  const desc     = localized(rp.productLocalizations,'description') || null;
  const images   = (rp.images||[]).map(img => img.url.startsWith('http') ? img.url : `${REWIX_IMG}${img.url}`);
  const brandId  = brandMap.get(brand.trim().toLowerCase()) || unknownBrandId;
  const categoryId    = resolveCategory(subcat || catRaw);
  const subcategoryId = resolveSubcategory(subcat || catRaw);

  const seen = new Map();
  for (const m of rp.models||[]) {
    const sku = buildSku(m);
    if (!seen.has(sku)) seen.set(sku, {...m});
    else seen.get(sku).availability = (seen.get(sku).availability||0) + (m.availability||0);
  }
  const models    = [...seen.values()];
  const stockQty  = models.reduce((s,m) => s + parseInt(m.availability||0), 0);
  const ref       = models.find(m => (m.availability||0) > 0) || models[0] || {};
  const cost      = ref.taxable != null ? parseFloat(ref.taxable) : null;
  const rrp       = ref.streetPrice != null ? parseFloat(ref.streetPrice) : null;
  const productSku = (models[0]?.code||'').trim() || String(rp.id);

  return { productSku, title, desc, categoryId, subcategoryId, gender, brandId, cost, rrp, stockQty, images };
}

// ── Main ───────────────────────────────────────────────────────────────────────
async function main() {
  log('═'.repeat(50));
  log(`🚀  Rewix → Vaitto  ${new Date().toISOString()}`);
  if (DRY_RUN) log('  [DRY RUN]');

  const db = new Client({ connectionString: DB_URL, connectionTimeoutMillis: 15000 });
  await db.connect();

  const full    = process.argv.includes('--full');
  const since   = !full && fs.existsSync(LAST_FILE) ? fs.readFileSync(LAST_FILE,'utf8').trim() : null;
  const cursor  = new Date(Date.now() - 15*60*1000).toISOString();

  const data     = await fetchRewix(since);
  const products = data.pageItems || [];
  if (!products.length) { log('Nothing to sync'); if (!DRY_RUN) fs.writeFileSync(LAST_FILE, cursor); await db.end(); return; }

  const existing           = await loadExisting(db);
  const { map: brandMap, unknownId } = await loadBrands(db);
  log(`  ${existing.size} existing · ${brandMap.size} brands`);

  const counts = { created:0, updated:0, deactivated:0, skipped:0, errors:0 };

  for (let i = 0; i < products.length; i++) {
    const rp = products[i];
    let parsed;
    try { parsed = parseProduct(rp, brandMap, unknownId); }
    catch(e) { warn(`Parse error ${rp.id}: ${e.message}`); counts.errors++; continue; }

    const { productSku, title, desc, categoryId, subcategoryId, gender,
            brandId, cost, rrp, stockQty, images } = parsed;
    const isNew = !existing.has(productSku);
    log(`[${i+1}/${products.length}]  ${productSku}  '${title}'  stock=${stockQty}`);

    if (isNew && stockQty === 0) { counts.skipped++; continue; }

    if (!isNew && stockQty === 0) {
      if (!DRY_RUN) {
        await db.query("UPDATE products SET active = false, stock_qty = 0 WHERE id = $1", [existing.get(productSku)]);
      }
      log(`  🔴 DEACTIVATED`); counts.deactivated++; continue;
    }

    const slug = `${SUPPLIER_ID.slice(0,8)}-${productSku}`.toLowerCase().replace(/\s+/g,'-').slice(0,200);
    const imagesJson = JSON.stringify(images.slice(0,10).map(u=>({url:u})));

    if (DRY_RUN) { log(`  [DRY RUN] ${isNew?'CREATE':'UPDATE'}`); continue; }

    try {
      if (isNew) {
        const res = await db.query(`
          INSERT INTO products (
            supplier_id, vaitto_sku, name, slug, brand_id,
            category_id, subcategory_id, gender, description,
            supplier_price, rrp, stock_qty, active, dropship_available,
            image_url, images
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,true,true,$13,$14)
          RETURNING id`,
          [SUPPLIER_ID, productSku, title, slug, brandId,
           categoryId, subcategoryId, gender, desc||'',
           cost, rrp, stockQty,
           images[0]||null, imagesJson]
        );
        existing.set(productSku, res.rows[0].id);
        log(`  ✅ CREATED`); counts.created++;
      } else {
        await db.query(`
          UPDATE products SET
            name=$1, brand_id=$2, category_id=$3, subcategory_id=$4,
            gender=$5, description=$6, supplier_price=$7, rrp=$8,
            stock_qty=$9, active=true, image_url=$10, images=$11
          WHERE id=$12`,
          [title, brandId, categoryId, subcategoryId,
           gender, desc||'', cost, rrp,
           stockQty, images[0]||null, imagesJson,
           existing.get(productSku)]
        );
        log(`  🔄 UPDATED`); counts.updated++;
      }
    } catch(e) { warn(`DB error ${productSku}: ${e.message}`); counts.errors++; }

    await sleep(50);
  }

  await db.end();
  if (!DRY_RUN) fs.writeFileSync(LAST_FILE, cursor);
  log(`\n  ✅${counts.created} created  🔄${counts.updated} updated  🔴${counts.deactivated} deactivated  ⏭${counts.skipped} skipped  ❌${counts.errors} errors`);
  log('═'.repeat(50));
}

main().catch(e => { console.error(e); process.exit(1); });
