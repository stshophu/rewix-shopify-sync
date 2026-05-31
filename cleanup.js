/**
 * RewixSync App Cleanup
 * ─────────────────────
 * Run this BEFORE and AFTER removing the RewixSync app.
 *
 * Usage:
 *   node cleanup.js --check    ← scan for leftovers (safe, read-only)
 *   node cleanup.js --fix      ← fix all issues found
 */

require('dotenv').config();
const fs = require('fs');

const SHOPIFY_STORE       = process.env.SHOPIFY_STORE;
const SHOPIFY_TOKEN       = process.env.SHOPIFY_TOKEN;
const SHOPIFY_API_VERSION = '2024-01';
const TARGET_LOCATION     = '3169 Warehouse';
const DELAY               = 600; // ms between API calls

const shopifyBase    = () => `https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}`;
const shopifyHeaders = () => ({
  'Content-Type':           'application/json',
  'X-Shopify-Access-Token': SHOPIFY_TOKEN,
});

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const log   = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);
const warn  = (msg) => console.warn(`[${new Date().toISOString()}] ⚠  ${msg}`);

// ─── FETCH ALL PRODUCTS (paginated) ───────────────────────────────────────────

async function fetchAllProducts() {
  log('Fetching all Shopify products…');
  const products = [];
  let url = `${shopifyBase()}/products.json?limit=250&fields=id,title,variants,tags`;
  while (url) {
    const res  = await fetch(url, { headers: shopifyHeaders() });
    const data = await res.json();
    products.push(...(data.products || []));
    const link = res.headers.get('Link') || '';
    const next = link.match(/<([^>]+)>;\s*rel="next"/)?.[1];
    url = next || null;
    if (url) await sleep(DELAY);
  }
  log(`Fetched ${products.length} products.`);
  return products;
}

// ─── GET LOCATIONS ─────────────────────────────────────────────────────────────

async function getLocations() {
  const res  = await fetch(`${shopifyBase()}/locations.json`, { headers: shopifyHeaders() });
  const data = await res.json();
  return data.locations || [];
}

// ─── CHECK ─────────────────────────────────────────────────────────────────────

async function check() {
  log('\n📋  CHECKING FOR REWIXSYNC LEFTOVERS\n');

  // 1. Locations
  log('── 1. Checking locations…');
  const locations = await getLocations();
  const rewixLocation  = locations.find(l => l.name?.toLowerCase().includes('rewix'));
  const targetLocation = locations.find(l => l.name === TARGET_LOCATION);

  if (rewixLocation) {
    warn(`RewixSync location still exists: "${rewixLocation.name}" (id: ${rewixLocation.id})`);
    warn('  → Transfer inventory to 3169 Warehouse before removing the app.');
  } else {
    log('✅  No RewixSync location found.');
  }

  if (targetLocation) {
    log(`✅  Target location found: "${targetLocation.name}" (id: ${targetLocation.id})`);
  } else {
    warn(`Target location "${TARGET_LOCATION}" not found in Shopify!`);
  }

  // 2. Variants — fulfillment service + inventory management
  log('\n── 2. Checking variant fulfillment & inventory management…');
  const products = await fetchAllProducts();

  let rewixFulfillmentCount = 0;
  let wrongInventoryCount   = 0;
  let rewixSkuCount         = 0;
  const problematicProducts = [];

  for (const p of products) {
    const issues = [];
    for (const v of p.variants || []) {
      // Check for RewixSync fulfillment service
      if (v.fulfillment_service && v.fulfillment_service !== 'manual') {
        rewixFulfillmentCount++;
        issues.push(`variant ${v.id}: fulfillment_service="${v.fulfillment_service}"`);
      }
      // Check inventory not managed by Shopify
      if (v.inventory_management && v.inventory_management !== 'shopify') {
        wrongInventoryCount++;
        issues.push(`variant ${v.id}: inventory_management="${v.inventory_management}"`);
      }
      // Count RewixSync SKUs
      if (v.sku?.startsWith('REWIXSYNCRM-')) rewixSkuCount++;
    }
    if (issues.length) problematicProducts.push({ id: p.id, title: p.title, issues });
  }

  if (rewixFulfillmentCount > 0) {
    warn(`${rewixFulfillmentCount} variants still have a non-manual fulfillment service.`);
    warn('  → Run with --fix to set them all to "manual".');
  } else {
    log('✅  All variants have manual fulfillment.');
  }

  if (wrongInventoryCount > 0) {
    warn(`${wrongInventoryCount} variants not managed by Shopify inventory.`);
    warn('  → Run with --fix to reassign them.');
  } else {
    log('✅  All variants use Shopify inventory management.');
  }

  log(`\n── 3. SKU summary…`);
  const rewixSyncSkus = products.flatMap(p => p.variants || []).filter(v => v.sku?.startsWith('REWIXSYNCRM-')).length;
  const nativeSkus    = products.flatMap(p => p.variants || []).filter(v => v.sku && !v.sku.startsWith('REWIXSYNCRM-')).length;
  const noSkus        = products.flatMap(p => p.variants || []).filter(v => !v.sku).length;
  log(`   REWIXSYNCRM- SKUs : ${rewixSyncSkus} (kept as-is — fine)`);
  log(`   Native Rewix SKUs : ${nativeSkus}`);
  log(`   No SKU            : ${noSkus}`);

  // 4. Metafields check (sample first 5 problematic products)
  log('\n── 4. Checking product metafields…');
  let rewixMetafieldCount = 0;
  const sampleProducts = products.slice(0, 50); // check first 50 as sample
  for (const p of sampleProducts) {
    const res  = await fetch(`${shopifyBase()}/products/${p.id}/metafields.json`, { headers: shopifyHeaders() });
    const data = await res.json();
    const rewixMeta = (data.metafields || []).filter(m => m.namespace?.toLowerCase().includes('rewix'));
    rewixMetafieldCount += rewixMeta.length;
    await sleep(300);
  }
  if (rewixMetafieldCount > 0) {
    log(`   Found ${rewixMetafieldCount} rewix metafields in first 50 products (harmless — just data).`);
  } else {
    log('✅  No problematic metafields found in sample.');
  }

  // Summary
  const totalIssues = rewixFulfillmentCount + wrongInventoryCount;
  log('\n─────────────────────────────────────────');
  if (totalIssues === 0) {
    log('✅  ALL CLEAR — safe to remove the RewixSync app.');
  } else {
    warn(`${totalIssues} issues found. Run  node cleanup.js --fix  to resolve before removing the app.`);
  }

  // Save report
  const report = {
    timestamp: new Date().toISOString(),
    locations: { rewixLocation, targetLocation },
    issues: { rewixFulfillmentCount, wrongInventoryCount },
    skus: { rewixSyncSkus, nativeSkus, noSkus },
    problematicProducts: problematicProducts.slice(0, 20),
  };
  fs.writeFileSync('cleanup-report.json', JSON.stringify(report, null, 2));
  log('\nFull report saved to cleanup-report.json');
}

// ─── FIX ───────────────────────────────────────────────────────────────────────

async function fix() {
  log('\n🔧  FIXING REWIXSYNC LEFTOVERS\n');

  const products  = await fetchAllProducts();
  const locations = await getLocations();
  const targetLoc = locations.find(l => l.name === TARGET_LOCATION);

  if (!targetLoc) {
    console.error(`❌  Target location "${TARGET_LOCATION}" not found. Cannot proceed.`);
    process.exit(1);
  }

  log(`Using location: "${targetLoc.name}" (id: ${targetLoc.id})`);

  let fixed = 0, failed = 0;

  for (const p of products) {
    for (const v of p.variants || []) {
      const needsFix = (v.fulfillment_service && v.fulfillment_service !== 'manual')
                    || (v.inventory_management && v.inventory_management !== 'shopify');

      if (!needsFix) continue;

      try {
        // Fix fulfillment service + inventory management
        const res = await fetch(`${shopifyBase()}/variants/${v.id}.json`, {
          method:  'PUT',
          headers: shopifyHeaders(),
          body: JSON.stringify({
            variant: {
              id:                   v.id,
              fulfillment_service:  'manual',
              inventory_management: 'shopify',
            },
          }),
        });

        if (res.ok) {
          // Move inventory to target location
          await fetch(`${shopifyBase()}/inventory_levels/set.json`, {
            method:  'POST',
            headers: shopifyHeaders(),
            body: JSON.stringify({
              inventory_item_id: v.inventory_item_id,
              location_id:       targetLoc.id,
              available:         v.inventory_quantity ?? 0,
            }),
          });
          fixed++;
          log(`  ✅ Fixed variant ${v.id} (${p.title})`);
        } else {
          failed++;
          warn(`  Failed to fix variant ${v.id}`);
        }
      } catch (err) {
        failed++;
        warn(`  Error fixing variant ${v.id}: ${err.message}`);
      }

      await sleep(DELAY);
    }
  }

  log(`\n✅  Fix complete — fixed: ${fixed}, failed: ${failed}`);
  log('You can now safely remove the RewixSync app.');
}

// ─── MAIN ──────────────────────────────────────────────────────────────────────

async function run() {
  const missing = ['SHOPIFY_STORE', 'SHOPIFY_TOKEN'].filter(k => !process.env[k]);
  if (missing.length) {
    console.error(`❌  Missing: ${missing.join(', ')} in .env`);
    process.exit(1);
  }

  if (process.argv.includes('--fix')) {
    await fix();
  } else {
    await check();
  }
}

run().catch(err => {
  console.error('❌  Fatal error:', err.message);
  process.exit(1);
});
