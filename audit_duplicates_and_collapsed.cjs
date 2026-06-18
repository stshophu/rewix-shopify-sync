#!/usr/bin/env node
// audit_duplicates_and_collapsed.cjs
// READ-ONLY. Cross-references the Rewix feed against Shopify to find:
//   A) Duplicate products  — same Rewix item present as >1 Shopify product
//   B) Collapsed variants  — Shopify product has FEWER variants than the Rewix
//      item has models (sizes lost to the shared-SKU bug)
// Writes a full report to audit_report.json. Changes nothing.
//
// Usage: node audit_duplicates_and_collapsed.cjs

require('dotenv').config();

const REWIX_BASE_URL = process.env.REWIX_BASE_URL;
const REWIX_API_KEY  = process.env.REWIX_API_KEY;
const REWIX_PASSWORD = process.env.REWIX_PASSWORD;
const SHOPIFY_STORE  = process.env.SHOPIFY_STORE;
const SHOPIFY_TOKEN  = process.env.SHOPIFY_TOKEN;
const API_VER        = '2024-01';
const LOCALES        = 'en_US,de_DE';

const basicAuth = () => Buffer.from(`${REWIX_API_KEY}:${REWIX_PASSWORD}`).toString('base64');
const shopHeaders = () => ({ 'X-Shopify-Access-Token': SHOPIFY_TOKEN, 'Content-Type': 'application/json' });
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Normalize a SKU to a key that identifies the underlying Rewix item.
// - "REWIXSYNCRM-20585" → "rewixsyncrm-20585" (keep the model id; do NOT strip it)
// - "m2200100-cg219-grigio-48" → "m2200100-cg219-grigio" (strip the size suffix)
// - "m2200100-cg219-grigio" → unchanged (already bare)
function bareCode(sku) {
  if (!sku) return '';
  const rs = sku.match(/^REWIXSYNCRM-(\d+)$/i);
  if (rs) return `rewixsyncrm-${rs[1]}`; // unique per model id — never collapse these
  return sku.replace(/-[^-]+$/, '');
}

async function fetchRewix() {
  const params = new URLSearchParams({ v: 'TEAL', acceptedlocales: LOCALES });
  const res = await fetch(`${REWIX_BASE_URL}/restful/export/api/products.json?${params}`, {
    headers: { Authorization: `Basic ${basicAuth()}`, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Rewix ${res.status}`);
  const data = await res.json();
  return data.pageItems || [];
}

async function fetchAllShopify() {
  const products = [];
  let url = `https://${SHOPIFY_STORE}/admin/api/${API_VER}/products.json?limit=250&fields=id,title,status,tags,variants`;
  while (url) {
    const res = await fetch(url, { headers: shopHeaders() });
    if (!res.ok) throw new Error(`Shopify ${res.status}`);
    const data = await res.json();
    products.push(...(data.products || []));
    const link = res.headers.get('Link') || '';
    url = link.match(/<([^>]+)>;\s*rel="next"/)?.[1] || null;
    if (url) await sleep(500);
    if (products.length % 1000 < 250) console.log(`  ...${products.length} Shopify products`);
  }
  return products;
}

async function main() {
  console.log('Fetching Rewix feed...');
  const rewix = await fetchRewix();
  console.log(`Rewix products: ${rewix.length}`);

  // Map every Rewix model bare-code → expected model count for its product
  const rewixByBare = new Map(); // bareCode -> { productName, expectedModels }
  for (const rp of rewix) {
    const codes = (rp.models || []).map(m => m.code).filter(Boolean);
    const expected = (rp.models || []).length;
    for (const c of codes) {
      rewixByBare.set(bareCode(c), { name: rp.name, expectedModels: expected });
      rewixByBare.set(c, { name: rp.name, expectedModels: expected });
    }
  }

  console.log('\nFetching Shopify products...');
  const shop = await fetchAllShopify();
  console.log(`Shopify products: ${shop.length}`);

  // Group Shopify products by the bare-code of their first RewixSync variant
  const byBare = new Map(); // bareKey -> [ {id,title,status,variantCount} ]
  let rewixSyncProducts = 0;

  for (const p of shop) {
    const tags = (p.tags || '').toLowerCase();
    if (!tags.includes('rewixsync')) continue;
    rewixSyncProducts++;
    const firstSku = (p.variants || []).find(v => v.sku)?.sku;
    if (!firstSku) continue;
    const key = bareCode(firstSku);
    if (!byBare.has(key)) byBare.set(key, []);
    byBare.get(key).push({
      id: p.id, title: p.title, status: p.status,
      variantCount: (p.variants || []).length,
      firstSku,
    });
  }

  // A) Duplicates: bareKey mapped to >1 Shopify product
  const duplicates = [];
  for (const [key, list] of byBare) {
    if (list.length > 1) duplicates.push({ key, count: list.length, products: list });
  }

  // B) Collapsed: Shopify variant count < Rewix expected model count
  const collapsed = [];
  for (const [key, list] of byBare) {
    const rewixInfo = rewixByBare.get(key);
    if (!rewixInfo) continue;
    for (const sp of list) {
      if (sp.variantCount < rewixInfo.expectedModels) {
        collapsed.push({
          shopifyId: sp.id, title: sp.title, status: sp.status,
          shopifyVariants: sp.variantCount,
          rewixModels: rewixInfo.expectedModels,
          missing: rewixInfo.expectedModels - sp.variantCount,
        });
      }
    }
  }

  console.log('\n' + '='.repeat(55));
  console.log('  AUDIT REPORT');
  console.log('='.repeat(55));
  console.log(`  RewixSync Shopify products:        ${rewixSyncProducts}`);
  console.log(`  Distinct Rewix items (bare codes): ${byBare.size}`);
  console.log(`  (A) Duplicate groups:              ${duplicates.length}`);
  console.log(`      Extra products to remove:      ${duplicates.reduce((s, d) => s + (d.count - 1), 0)}`);
  console.log(`  (B) Collapsed products:            ${collapsed.length}`);
  console.log(`      Total missing variants:        ${collapsed.reduce((s, c) => s + c.missing, 0)}`);
  console.log('='.repeat(55));

  if (duplicates.length) {
    console.log('\n  Sample duplicate groups (up to 10):');
    for (const d of duplicates.slice(0, 10)) {
      console.log(`   "${d.key}" → ${d.count} products: ${d.products.map(p => `${p.id}(${p.status},${p.variantCount}v)`).join(', ')}`);
    }
  }
  if (collapsed.length) {
    console.log('\n  Sample collapsed products (up to 10):');
    for (const c of collapsed.slice(0, 10)) {
      console.log(`   [${c.shopifyId}] "${c.title}" — ${c.shopifyVariants}/${c.rewixModels} variants (missing ${c.missing})`);
    }
  }

  const fs = require('fs');
  fs.writeFileSync('audit_report.json', JSON.stringify({ duplicates, collapsed }, null, 2));
  console.log('\n  Full report → audit_report.json');
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
