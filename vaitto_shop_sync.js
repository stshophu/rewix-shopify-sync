#!/usr/bin/env node
/**
 * VAITTO → Siebentaschen Shopify sync (started 20 Nov 2026 with Fashiondealer).
 *
 * Reads products straight from the VAITTO database and keeps the matching
 * Shopify products up to date. It only touches products tagged `VaittoFeed`
 * and, on those, only the fields it owns:
 *
 *   price, compare-at price (= RRP), unit cost, stock at the supplier's
 *   Shopify location, and a missing barcode.
 *
 * It never changes titles, descriptions, images, handles, tags, status or
 * metafields of existing products, so WSNL, BUYMA, Stork and POIZON syncs are
 * not affected. New VAITTO products are created as DRAFTS only, and only when
 * VAITTO_SYNC_MAX_CREATE > 0.
 *
 * Price rule: pricing.cjs (same rule as Rewix), per supplier settings below.
 *
 * Env:
 *   VAITTO_DB_URL            Postgres connection string of the VAITTO DB (read only use)
 *   SHOPIFY_STORE            e.g. modalist-de.myshopify.com
 *   SHOPIFY_TOKEN            Admin API token
 *   VAITTO_SYNC_DRY_RUN      "true" → compute and report, write nothing
 *   VAITTO_SYNC_MAX_CREATE   max new draft products per run (default 0 = none)
 *   VAITTO_SYNC_REPORT       report CSV path (default vaitto_shop_sync_report.csv)
 * CLI: --dry-run overrides VAITTO_SYNC_DRY_RUN.
 */
'use strict';
const fs = require('fs');
const { Client } = (() => { try { return require('pg'); } catch { return {}; } })();
const { priceRewix } = require('./pricing.cjs');

// ─── SETTINGS ──────────────────────────────────────────────────────────────
const API_VERSION = '2026-10';
const FEED_TAG = 'VaittoFeed';

// One entry per VAITTO warehouse that is synced into the shop.
// Add Tluxy/Loxuno/Rewix here later — one supplier at a time, after pausing
// its old workflow.
const SUPPLIERS = {
  'EU-WAR-6': {                                   // Fashiondealer, Rimini
    skuPrefix: 'FD-',
    locationId: 'gid://shopify/Location/126311825748', // "3180 Warehouse"
    pricing: priceRewix,                             // same rule as Rewix
    tags: [FEED_TAG],
    // New drafts: same filters as the 13/14 Nov test set
    create: {
      minRrp: 100,
      minImages: 2,
      skipName: /\b(sunglasses|optical|wallet|card ?holder|keyring|key ?ring|envelope|belt)\b/i,
      skipSubcategory: /^(sunglasses|wallets|belts|small leather goods|key holders)$/i,
    },
  },
};

const WEIGHT_GRAMS = { Clothing: 600, Coats: 1600, Shoes: 1200, Bags: 900, Accessories: 250, Jewelry: 120 };
const SAFETY_MIN_FOUND = 0.5; // abort if VAITTO knows fewer than 50 % of the shop's SKUs

// ─── ARGS / ENV ────────────────────────────────────────────────────────────
const DRY = process.argv.includes('--dry-run') || process.env.VAITTO_SYNC_DRY_RUN === 'true';
const MAX_CREATE = parseInt(process.env.VAITTO_SYNC_MAX_CREATE || '0', 10) || 0;
const REPORT = process.env.VAITTO_SYNC_REPORT || 'vaitto_shop_sync_report.csv';
const { VAITTO_DB_URL, SHOPIFY_STORE, SHOPIFY_TOKEN } = process.env;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const money = n => (Math.round(n * 100) / 100).toFixed(2);
const same = (a, b) => Math.abs(Number(a || 0) - Number(b || 0)) < 0.005;

// ─── SHOPIFY CLIENT (GraphQL, cost-aware retry) ────────────────────────────
async function gql(query, variables = {}, attempt = 1) {
  const res = await fetch(`https://${SHOPIFY_STORE}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': SHOPIFY_TOKEN },
    body: JSON.stringify({ query, variables }),
  });
  if (res.status === 429 || res.status >= 500) {
    if (attempt > 6) throw new Error(`Shopify HTTP ${res.status}`);
    await sleep(1000 * attempt); return gql(query, variables, attempt + 1);
  }
  const body = await res.json();
  const throttled = (body.errors || []).some(e => e.extensions && e.extensions.code === 'THROTTLED');
  if (throttled) {
    if (attempt > 8) throw new Error('Shopify throttled');
    await sleep(2000 * attempt); return gql(query, variables, attempt + 1);
  }
  if (body.errors) throw new Error('Shopify: ' + JSON.stringify(body.errors).slice(0, 500));
  // Gentle pacing: wait if the bucket is getting low
  const t = body.extensions && body.extensions.cost && body.extensions.cost.throttleStatus;
  if (t && t.currentlyAvailable < 300) await sleep(Math.ceil((300 - t.currentlyAvailable) / t.restoreRate) * 1000);
  return body.data;
}

const PRODUCTS_Q = `query($q:String!,$after:String,$loc:ID!){
  products(first:50, after:$after, query:$q){
    pageInfo{ hasNextPage endCursor }
    nodes{ id status title
      variants(first:100){ nodes{ id sku price compareAtPrice
        barcodes(first:3){ nodes{ value } }
        inventoryItem{ id unitCost{ amount }
          inventoryLevel(locationId:$loc){ quantities(names:["available"]){ quantity } } } } } } } }`;

async function loadShopVariants(locationId) {
  const out = []; let after = null;
  do {
    const d = await gql(PRODUCTS_Q, { q: `tag:${FEED_TAG} AND -status:archived`, after, loc: locationId });
    for (const p of d.products.nodes) {
      for (const v of p.variants.nodes) {
        const lvl = v.inventoryItem && v.inventoryItem.inventoryLevel;
        out.push({
          productId: p.id, productStatus: p.status, productTitle: p.title,
          variantId: v.id, sku: (v.sku || '').trim(), price: v.price, compareAt: v.compareAtPrice,
          barcode: (v.barcodes.nodes[0] || {}).value || '',
          inventoryItemId: v.inventoryItem.id,
          cost: v.inventoryItem.unitCost ? v.inventoryItem.unitCost.amount : null,
          stocked: !!lvl, qty: lvl ? ((lvl.quantities[0] || {}).quantity || 0) : null,
        });
      }
    }
    after = d.products.pageInfo.hasNextPage ? d.products.pageInfo.endCursor : null;
  } while (after);
  return out;
}

// ─── VAITTO DB ─────────────────────────────────────────────────────────────
async function loadVaitto(db, warehouse) {
  const { rows } = await db.query(`
    select p.id, p.vaitto_sku, p.name, p.description, p.composition, p.season, p.gender,
           p.active, coalesce(p.excluded_reason,'') as excluded_reason,
           p.supplier_price::numeric as cost, p.rrp::numeric as rrp,
           b.name as brand, c.name as category, sc.name as subcategory,
           coalesce(nullif(p.images_src::text, '')::jsonb, nullif(p.images::text, '')::jsonb, '[]'::jsonb) as images,
           greatest(p.updated_at, (select max(v2.updated_at) from product_variants v2 where v2.product_id = p.id)) as updated_at,
           coalesce((select json_agg(json_build_object('sku', v.sku, 'size', v.size, 'colour', v.colour,
                       'barcode', v.barcode, 'stock', v.stock_qty) order by v.sku)
                     from product_variants v where v.product_id = p.id), '[]') as variants
      from products p
      join suppliers s on s.id = p.supplier_id
      left join brands b on b.id = p.brand_id
      left join categories c on c.id = p.category_id
      left join subcategories sc on sc.id = p.subcategory_id
     where s.display_name = $1`, [warehouse]);
  return rows.map(r => ({ ...r, cost: Number(r.cost), rrp: r.rrp == null ? null : Number(r.rrp),
    images: Array.isArray(r.images) ? r.images : [], variants: r.variants || [] }));
}

// Same clean-up as the test import: one variant per colour+size
const sizeFix = s => { s = String(s || '').trim().replace(/^(\d+)\s*mm$/i, '$1 mm');
  return /^(uni|u|unica|os|one size|tu)$/i.test(s) || !s ? 'One Size' : s; };
const colFix = c => { c = String(c || '').trim(); if (!c) return 'Multicolor';
  if (/^(lense|frame) color:/i.test(c)) { const m = c.match(/Main Color:\s*([^;,]+)/i); if (m) return m[1].trim(); }
  return c.split(/\s*[;,]\s*(?:main color:)?/i)[0].replace(/^(main|lense|frame) color:\s*/i, '').trim() || 'Multicolor'; };
const validBarcode = b => /^\d{12,14}$/.test(String(b || '').trim());

// ─── PRICE + STOCK TARGET PER VARIANT ──────────────────────────────────────
function target(prod, variant, cfg) {
  // Sellable when VAITTO has it active, or only hid it from the B2B catalogue
  // (excluded_reason, e.g. the €100 floor) — those still sell in Siebentaschen.
  const sellable = prod.active || prod.excluded_reason !== '';
  const pr = cfg.pricing({ cost: prod.cost, rrp: prod.rrp, brand: prod.brand || '' });
  if (pr.price == null) return { skip: 'no-cost' };
  let qty = sellable ? Math.max(0, parseInt(variant.stock, 10) || 0) : 0;
  let note = sellable ? '' : 'inactive in VAITTO';
  if (pr.reviewReason === 'unprofitable') { qty = 0; note = 'unprofitable at RRP'; }
  return {
    price: money(pr.price),
    compareAt: prod.rrp && prod.rrp > pr.price ? money(prod.rrp) : null,
    cost: money(prod.cost),
    qty, note,
  };
}

// ─── NEW DRAFT PRODUCTS ────────────────────────────────────────────────────
const slug = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const SUB_TYPE = { Shoulder: 'Shoulder Bags', Crossbody: 'Crossbody Bags', Tote: 'Tote Bags', Backpack: 'Backpacks', Clutch: 'Clutches' };

function buildNewProduct(p, cfg) {
  const g = p.gender === 'Women' ? 'Woman' : p.gender === 'Men' ? 'Man' : null;
  const brand = p.brand || '';
  const rest = p.name.replace(new RegExp('^' + brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*', 'i'), '').replace(/\s+/g, ' ').trim();
  const title = [brand, g, rest].filter(Boolean).join(' ');
  const sub = p.subcategory ? (SUB_TYPE[p.subcategory] || p.subcategory) : (p.category || '');
  const productType = (p.gender === 'Women' ? 'Women ' : p.gender === 'Men' ? 'Men ' : '') + sub;
  const grams = (p.category === 'Coats' || /\b(coat|cape|down jacket|winter jacket|parka|puffer)\b/i.test(p.name)) ? WEIGHT_GRAMS.Coats : (WEIGHT_GRAMS[p.category] || 600);
  const lines = String(p.description || '').split('\n').map(s => s.trim()).filter(Boolean);
  const vmap = new Map();
  for (const v of p.variants) {
    const key = colFix(v.colour) + '|' + sizeFix(v.size);
    const o = vmap.get(key);
    if (!o || (v.stock | 0) > (o.stock | 0)) vmap.set(key, v);
  }
  const vs = [...vmap.values()];
  const variants = vs.map(v => {
    const t = target(p, v, cfg);
    return {
      sku: v.sku, price: t.price, ...(t.compareAt ? { compareAtPrice: t.compareAt } : {}),
      ...(validBarcode(v.barcode) ? { barcodes: [{ value: String(v.barcode).trim() }] } : {}),
      optionValues: [{ optionName: 'Color', name: colFix(v.colour) }, { optionName: 'Size', name: sizeFix(v.size) }],
      inventoryPolicy: 'DENY',
      inventoryItem: { tracked: true, cost: t.cost, measurement: { weight: { value: grams / 1000, unit: 'KILOGRAMS' } } },
      inventoryQuantities: [{ locationId: cfg.locationId, name: 'available', quantity: t.qty }],
    };
  });
  return {
    title, handle: slug(title) + '-' + slug(String(p.vaitto_sku || p.id)),
    vendor: brand, productType, status: 'DRAFT',
    descriptionHtml: `<p>${esc(title)}.</p>` + (lines.length ? '<ul>' + lines.map(l => `<li>${esc(l)}</li>`).join('') + '</ul>' : ''),
    tags: [p.category, brand, g || 'Unisex', p.subcategory, p.season, ...cfg.tags].filter(Boolean),
    productOptions: [
      { name: 'Color', values: [...new Set(vs.map(v => colFix(v.colour)))].map(name => ({ name })) },
      { name: 'Size', values: [...new Set(vs.map(v => sizeFix(v.size)))].map(name => ({ name })) },
    ],
    files: p.images.slice(0, 6).map((u, i) => ({ originalSource: u, contentType: 'IMAGE', ...(i ? {} : { alt: title }) })),
    metafields: [
      { namespace: 'vaitto', key: 'product_id', type: 'single_line_text_field', value: p.id },
      { namespace: 'vaitto', key: 'sku', type: 'single_line_text_field', value: String(p.vaitto_sku || '') },
    ],
    variants,
  };
}

function eligibleForCreate(p, cfg) {
  const c = cfg.create;
  if (!p.active) return false;
  if (!(p.rrp >= c.minRrp)) return false;
  if (p.images.length < c.minImages) return false;
  if (c.skipName.test(p.name) || c.skipSubcategory.test(p.subcategory || '')) return false;
  if (!p.variants.some(v => (v.stock | 0) > 0)) return false;
  const pr = cfg.pricing({ cost: p.cost, rrp: p.rrp, brand: p.brand || '' });
  return pr.price != null && !pr.reviewReason;
}

// ─── WRITES ────────────────────────────────────────────────────────────────
const BULK_UPDATE = `mutation($pid:ID!,$v:[ProductVariantsBulkInput!]!){
  productVariantsBulkUpdate(productId:$pid, variants:$v){ userErrors{ field message } } }`;
const SET_QTY = `mutation($input:InventorySetQuantitiesInput!){
  inventorySetQuantities(input:$input){ userErrors{ field message code } } }`;
const ACTIVATE = `mutation($item:ID!,$loc:ID!,$q:Int){
  inventoryActivate(inventoryItemId:$item, locationId:$loc, available:$q){ userErrors{ field message } } }`;
const CREATE = `mutation($h:String!,$p:ProductSetInput!){
  productSet(identifier:{handle:$h}, input:$p){ product{ id } userErrors{ field message } } }`;

// ─── MAIN ──────────────────────────────────────────────────────────────────
async function main() {
  for (const [k, v] of Object.entries({ VAITTO_DB_URL, SHOPIFY_STORE, SHOPIFY_TOKEN })) {
    if (!v) { console.error(`Missing ${k}`); process.exit(1); }
  }
  const report = [['warehouse', 'sku', 'product', 'action', 'field', 'old', 'new', 'note']];
  const log = (...a) => console.log(...a);
  const errors = [];
  const db = new Client({ connectionString: VAITTO_DB_URL, connectionTimeoutMillis: 15000 });
  await db.connect();
  log(`VAITTO → Shopify sync ${DRY ? '(DRY RUN — nothing is written)' : ''}`);

  for (const [warehouse, cfg] of Object.entries(SUPPLIERS)) {
    const vaitto = await loadVaitto(db, warehouse);
    const bySku = new Map();
    for (const p of vaitto) for (const v of p.variants) if (v.sku) bySku.set(String(v.sku).trim().toUpperCase(), { p, v });
    const newest = vaitto.reduce((m, p) => (p.updated_at > m ? p.updated_at : m), new Date(0));
    log(`\n[${warehouse}] VAITTO: ${vaitto.length} products, ${bySku.size} variants, data last changed ${newest.toISOString ? newest.toISOString() : newest}`);

    const shop = (await loadShopVariants(cfg.locationId)).filter(s => s.sku.toUpperCase().startsWith(cfg.skuPrefix));
    const found = shop.filter(s => bySku.has(s.sku.toUpperCase())).length;
    log(`[${warehouse}] Shop: ${shop.length} variants tagged ${FEED_TAG}, ${found} found in VAITTO`);
    if (shop.length >= 20 && found < shop.length * SAFETY_MIN_FOUND) {
      const msg = `[${warehouse}] ABORT: VAITTO only knows ${found}/${shop.length} of the shop's SKUs — refusing to zero stock.`;
      log(msg); errors.push(msg); continue;
    }

    // Updates of existing variants
    const byProduct = new Map(); const qtyChanges = []; const activations = [];
    let unchanged = 0;
    for (const s of shop) {
      const hit = bySku.get(s.sku.toUpperCase());
      let t;
      if (!hit) t = { qty: 0, note: 'not in VAITTO any more' };
      else {
        t = target(hit.p, hit.v, cfg);
        if (t.skip) { report.push([warehouse, s.sku, s.productTitle, 'skip', '', '', '', t.skip]); continue; }
      }
      const upd = { id: s.variantId }; let changed = false;
      if (t.price && !same(s.price, t.price)) { upd.price = t.price; report.push([warehouse, s.sku, s.productTitle, 'update', 'price', s.price, t.price, '']); changed = true; }
      if (t.price && (t.compareAt || null) !== (s.compareAt ? money(Number(s.compareAt)) : null)) {
        upd.compareAtPrice = t.compareAt; report.push([warehouse, s.sku, s.productTitle, 'update', 'compareAt', s.compareAt || '', t.compareAt || '', '']); changed = true; }
      if (t.cost && !same(s.cost, t.cost)) { upd.inventoryItem = { cost: t.cost }; report.push([warehouse, s.sku, s.productTitle, 'update', 'cost', s.cost || '', t.cost, '']); changed = true; }
      if (hit && !s.barcode && validBarcode(hit.v.barcode)) {
        upd.barcodes = [{ value: String(hit.v.barcode).trim() }]; report.push([warehouse, s.sku, s.productTitle, 'update', 'barcode', '', hit.v.barcode, '']); changed = true; }
      if (changed) { if (!byProduct.has(s.productId)) byProduct.set(s.productId, []); byProduct.get(s.productId).push(upd); }
      if (!s.stocked) { activations.push({ s, qty: t.qty }); report.push([warehouse, s.sku, s.productTitle, 'update', 'stock', 'not stocked', t.qty, t.note]); }
      else if (s.qty !== t.qty) { qtyChanges.push({ inventoryItemId: s.inventoryItemId, locationId: cfg.locationId, quantity: t.qty, changeFromQuantity: s.qty });
        report.push([warehouse, s.sku, s.productTitle, 'update', 'stock', s.qty, t.qty, t.note]); }
      if (!changed && s.stocked && s.qty === t.qty) unchanged++;
    }

    // New drafts
    const shopSkus = new Set(shop.map(s => s.sku.toUpperCase()));
    const candidates = vaitto.filter(p => !p.variants.some(v => shopSkus.has(String(v.sku || '').trim().toUpperCase())) && eligibleForCreate(p, cfg));
    const toCreate = candidates.slice(0, MAX_CREATE);
    for (const p of toCreate) report.push([warehouse, (p.variants[0] || {}).sku || '', p.name, 'create draft', '', '', '', '']);

    log(`[${warehouse}] Planned: ${[...byProduct.values()].reduce((a, b) => a + b.length, 0)} variant updates in ${byProduct.size} products, ` +
        `${qtyChanges.length + activations.length} stock changes, ${unchanged} unchanged, ` +
        `${toCreate.length} new drafts (${candidates.length} eligible, limit ${MAX_CREATE})`);
    if (DRY) continue;

    for (const [pid, variants] of byProduct) {
      const d = await gql(BULK_UPDATE, { pid, v: variants });
      const ue = d.productVariantsBulkUpdate.userErrors;
      if (ue.length) errors.push(`${pid}: ${JSON.stringify(ue)}`);
    }
    for (let i = 0; i < qtyChanges.length; i += 100) {
      const d = await gql(SET_QTY, { input: { name: 'available', reason: 'correction', referenceDocumentUri: 'gid://vaitto/Sync/shop', quantities: qtyChanges.slice(i, i + 100) } });
      const ue = d.inventorySetQuantities.userErrors;
      if (ue.length) errors.push(`stock batch ${i}: ${JSON.stringify(ue).slice(0, 300)}`);
    }
    for (const { s, qty } of activations) {
      const d = await gql(ACTIVATE, { item: s.inventoryItemId, loc: cfg.locationId, q: qty });
      const ue = d.inventoryActivate.userErrors;
      if (ue.length) errors.push(`${s.sku} activate: ${JSON.stringify(ue)}`);
    }
    for (const p of toCreate) {
      const input = buildNewProduct(p, cfg);
      const d = await gql(CREATE, { h: input.handle, p: input });
      const ue = d.productSet.userErrors;
      if (ue.length) errors.push(`${p.name} create: ${JSON.stringify(ue)}`);
    }
    log(`[${warehouse}] Written.`);
  }

  await db.end();
  fs.writeFileSync(REPORT, report.map(r => r.map(x => /[",\n]/.test(String(x ?? '')) ? `"${String(x).replace(/"/g, '""')}"` : (x ?? '')).join(',')).join('\n'));
  log(`\nReport: ${REPORT} (${report.length - 1} rows)`);
  if (errors.length) { log(`\n${errors.length} error(s):`); errors.slice(0, 50).forEach(e => log(' - ' + e)); process.exit(1); }
  log('Done, no errors.');
}

module.exports = { target, buildNewProduct, eligibleForCreate, colFix, sizeFix, SUPPLIERS };
if (require.main === module) main().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
