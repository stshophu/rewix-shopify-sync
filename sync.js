/**
 * Rewix → Shopify Product Sync  (with Claude SEO optimisation)
 * ─────────────────────────────────────────────────────────────
 * • Fetches products from the Rewix API
 * • For NEW products: generates bilingual DE+EN SEO content via Claude
 * • Creates / updates products in Shopify
 * • Incremental sync — only changed products after the first run
 *
 * Usage:
 *   node sync.js          ← smart sync (full first time, incremental after)
 *   node sync.js --full   ← force a full catalog re-download
 */

require('dotenv').config();
const fs   = require('fs');
const path = require('path');

// ─── CONFIG ────────────────────────────────────────────────────────────────────

const REWIX_BASE_URL   = process.env.REWIX_BASE_URL;
const REWIX_API_KEY    = process.env.REWIX_API_KEY;
const REWIX_PASSWORD   = process.env.REWIX_PASSWORD;
const REWIX_IMAGE_BASE = process.env.REWIX_IMAGE_BASE || REWIX_BASE_URL;

const SHOPIFY_STORE    = process.env.SHOPIFY_STORE;
const SHOPIFY_TOKEN    = process.env.SHOPIFY_TOKEN;

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const LOCALES             = 'en_US,de_DE';
const LAST_UPDATE_FILE    = path.join(__dirname, '.last_sync_timestamp');
const SHOPIFY_API_VERSION = '2024-01';

// Delays to stay within API rate limits
const SHOPIFY_DELAY   = 600;  // ms between Shopify calls (~100/min)
const CLAUDE_DELAY    = 1000; // ms between Claude calls (generous buffer)

// ─── HELPERS ───────────────────────────────────────────────────────────────────

const log  = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);
const warn = (msg) => console.warn(`[${new Date().toISOString()}] ⚠  ${msg}`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const basicAuth = () => Buffer.from(`${REWIX_API_KEY}:${REWIX_PASSWORD}`).toString('base64');

// ─── CLAUDE SEO GENERATION ─────────────────────────────────────────────────────

/**
 * Calls Claude to generate bilingual SEO content for a Rewix product.
 * Returns { title_de, title_en, description_de, description_en,
 *           meta_de, meta_en, tags } or null on failure.
 */
async function generateSEOContent(rp) {
  if (!ANTHROPIC_API_KEY) {
    warn('ANTHROPIC_API_KEY not set — skipping SEO optimisation');
    return null;
  }

  const brand    = tagValue(rp.tags, 'brand')    || '';
  const category = tagValue(rp.tags, 'category') || '';
  const gender   = tagValue(rp.tags, 'gender')   || '';
  const color    = rp.models?.[0]?.color         || '';
  const rawDesc  = localized(rp.productLocalizations, 'description') || rp.name || '';

  // Collect unique sizes and colors from models
  const colors = [...new Set((rp.models || []).map(m => m.color).filter(Boolean))].slice(0, 5);
  const sizes  = [...new Set((rp.models || []).map(m => m.size).filter(Boolean))].slice(0, 10);

  const prompt = `You are an SEO copywriter for Siebentaschen (siebentaschen.com), a German luxury fashion e-commerce store selling high-end designer brands. Your tone is sophisticated, confident, and aspirational — never generic.

Generate bilingual SEO content for this product:

Brand: ${brand}
Product name: ${rp.name}
Category: ${category}
Gender: ${gender}
Colors available: ${colors.join(', ') || color}
Sizes available: ${sizes.join(', ')}
Supplier description: ${rawDesc.replace(/<[^>]*>/g, ' ').substring(0, 400)}

Return ONLY a valid JSON object — no markdown, no explanation, no backticks:
{
  "title_de": "German SEO title: Brand + product type + key distinguishing feature. 55-65 characters. Naturally includes main keyword.",
  "title_en": "English SEO title: same structure. 55-65 characters.",
  "description_de": "German HTML. Format: <p>2-3 sentence evocative intro highlighting the luxury appeal and key features.</p><ul><li>Material / Verarbeitung</li><li>Passform / Schnitt</li><li>Details (closures, hardware, lining etc)</li><li>Anlass / Styling-Tipp</li></ul>  Use real product details. Luxury tone. 120-180 words total.",
  "description_en": "English HTML. Same structure and detail level as German. 120-180 words.",
  "meta_de": "German meta description. 148-155 characters. Benefit-led opening, includes brand + product type + one key feature. Ends with a soft call to action.",
  "meta_en": "English meta description. Same approach. 148-155 characters.",
  "tags": ["array", "of", "5-8", "relevant", "shopify", "tags", "in", "english", "lowercase"]
}`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      'claude-sonnet-4-20250514',
        max_tokens: 1200,
        messages:   [{ role: 'user', content: prompt }],
      }),
    });

    if (!res.ok) {
      warn(`Claude API error ${res.status} for product ${rp.code}`);
      return null;
    }

    const data = await res.json();
    const text = data.content?.map(b => b.text || '').join('').trim();

    // Strip any accidental markdown fences
    const clean = text.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
    return JSON.parse(clean);

  } catch (err) {
    warn(`SEO generation failed for ${rp.code}: ${err.message}`);
    return null;
  }
}

// ─── REWIX API ──────────────────────────────────────────────────────────────────

async function fetchRewixProducts(since = null) {
  const params = new URLSearchParams({ v: 'TEAL', acceptedlocales: LOCALES });
if (since) {
    const ageMs = Date.now() - new Date(since).getTime();
    if (ageMs > 3.5 * 60 * 60 * 1000) {
      log('Saved timestamp older than Rewix 4h incremental window - falling back to full sync.');
      since = null;
    } else {
      params.set('since', since);
    }
  }

  const url = `${REWIX_BASE_URL}/restful/export/api/products.json?${params}`;
  log(`Fetching Rewix catalog${since ? ` (changes since ${since})` : ' (full)'}…`);

  const res = await fetch(url, {
    headers: {
      Authorization: `Basic ${basicAuth()}`,
      Accept:        'application/json',
    },
  });

  if (!res.ok) throw new Error(`Rewix API error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  log(`Rewix returned ${data.pageItems?.length ?? 0} products (lastUpdate: ${data.lastUpdate})`);
  return data;
}

// ─── DATA HELPERS ──────────────────────────────────────────────────────────────

function localized(localizations, field) {
  if (!localizations) return '';
  const obj = localizations[field];
  if (!obj) return '';
  if (obj['en_US']?.value) return obj['en_US'].value;
  const first = Object.values(obj).find(v => v?.value);
  return first?.value || '';
}

function tagValue(tags, tagName) {
  return tags?.find(t => t.name === tagName)?.value?.value || '';
}

// ─── REWIX → SHOPIFY MAPPING ───────────────────────────────────────────────────

/**
 * Build a Shopify product payload from a Rewix product + optional SEO content.
 * If seo is null, falls back to the original Rewix content.
 */
function buildShopifyPayload(rp, seo) {
  const brand       = tagValue(rp.tags, 'brand')    || '';
  const category    = tagValue(rp.tags, 'category') || '';
  const gender      = tagValue(rp.tags, 'gender')   || '';
  const season      = tagValue(rp.tags, 'season')   || '';

  // ── Titles & descriptions ──────────────────────────────────────
  const title    = seo?.title_de    || localized(rp.productLocalizations, 'productName') || rp.name;
  const bodyHtml = seo?.description_de || localized(rp.productLocalizations, 'description') || '';

  // ── Tags ──────────────────────────────────────────────────────
  const baseTags  = [brand, category, gender, season, 'RewixSync'].filter(Boolean);
  const seoTags   = seo?.tags || [];
  const allTags   = [...new Set([...baseTags, ...seoTags])].join(', ');

  // ── Images ────────────────────────────────────────────────────
  const images = (rp.images || []).map(img => ({
    src: img.url.startsWith('http') ? img.url : `${REWIX_IMAGE_BASE}${img.url}`,
  }));

  // ── Variants ──────────────────────────────────────────────────
  const variants = (rp.models || []).map(m => ({
    sku:                  m.code,
    price:                String(m.suggestedPrice ?? m.streetPrice ?? 0),
    compare_at_price:     m.streetPrice ? String(m.streetPrice) : undefined,
    barcode:              m.barcode || undefined,
    option1:              m.modelLocalizations?.color?.['en_US']?.value || m.color || 'Default',
    option2:              m.modelLocalizations?.size?.['en_US']?.value  || m.size  || undefined,
    inventory_management: 'shopify',
    inventory_quantity:   m.availability ?? 0,
    weight:               rp.weight ? parseFloat(rp.weight) : undefined,
    weight_unit:          rp.weight ? 'kg' : undefined,
    fulfillment_service:  'manual',
  }));

  const options = [{ name: 'Color' }];
  if (variants.some(v => v.option2)) options.push({ name: 'Size' });

  // ── Metafields ────────────────────────────────────────────────
  // German SEO title + meta description (Shopify native SEO fields)
  // English content stored separately for translation apps / Translate & Adapt
  const metafields = [
    seo?.meta_de && {
      namespace: 'global', key: 'description_tag',
      value: seo.meta_de, type: 'single_line_text_field',
    },
    seo?.title_en && {
      namespace: 'translations', key: 'title_en',
      value: seo.title_en, type: 'single_line_text_field',
    },
    seo?.description_en && {
      namespace: 'translations', key: 'description_en',
      value: seo.description_en, type: 'multi_line_text_field',
    },
    seo?.meta_en && {
      namespace: 'translations', key: 'meta_description_en',
      value: seo.meta_en, type: 'single_line_text_field',
    },
    { namespace: 'rewix', key: 'product_code', value: rp.code,         type: 'single_line_text_field' },
    { namespace: 'rewix', key: 'product_id',   value: String(rp.id),   type: 'single_line_text_field' },
    rp.hs     && { namespace: 'rewix', key: 'hs_code', value: rp.hs,         type: 'single_line_text_field' },
    rp.madein && { namespace: 'rewix', key: 'made_in', value: rp.madein,     type: 'single_line_text_field' },
  ].filter(Boolean);

  return {
    product: {
      title,
      body_html:    bodyHtml,
      vendor:       brand,
      product_type: category,
      tags:         allTags,
      status:       rp.online === false ? 'draft' : 'active',
      options,
      variants,
      images,
      metafields,
    },
  };
}

// ─── SHOPIFY API ───────────────────────────────────────────────────────────────

const shopifyBase    = () => `https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}`;
const shopifyHeaders = () => ({
  'Content-Type':           'application/json',
  'X-Shopify-Access-Token': SHOPIFY_TOKEN,
});

async function loadShopifyIndex() {
  log('Building Shopify product index (this may take a moment for large catalogs)…');

  // Two lookup maps:
  // 1. skuToProductId   — native Rewix SKU (e.g. "GD6423_36") → Shopify product id
  // 2. modelIdToData    — Rewix numeric model id (e.g. 20585) → { productId, variantId }
  //    Handles products imported by the RewixSync app whose SKUs look like "REWIXSYNCRM-20585"
  const skuToProductId = new Map();
  const modelIdToData  = new Map();

  let url = `${shopifyBase()}/products.json?limit=250&fields=id,variants`;
  while (url) {
    const res = await fetch(url, { headers: shopifyHeaders() });
    if (!res.ok) throw new Error(`Shopify index error: ${res.status}`);
    const data = await res.json();
    for (const p of data.products || []) {
      for (const v of p.variants || []) {
        if (!v.sku) continue;
        // Native Rewix SKU index
        skuToProductId.set(v.sku, p.id);
        // RewixSync app SKU format: "REWIXSYNCRM-{modelId}"
        const match = v.sku.match(/^REWIXSYNCRM-(\d+)$/i);
        if (match) {
          modelIdToData.set(parseInt(match[1], 10), { productId: p.id, variantId: v.id });
        }
      }
    }
    const link = res.headers.get('Link') || '';
    const next = link.match(/<([^>]+)>;\s*rel="next"/)?.[1];
    url = next || null;
    if (url) await sleep(SHOPIFY_DELAY);
  }

  const rewixSyncCount = modelIdToData.size;
  const nativeCount    = skuToProductId.size - rewixSyncCount;
  log(`Shopify index built: ${skuToProductId.size} variants found (${rewixSyncCount} from RewixSync app, ${nativeCount} native).`);
  return { skuToProductId, modelIdToData };
}

async function createShopifyProduct(payload) {
  const res = await fetch(`${shopifyBase()}/products.json`, {
    method: 'POST', headers: shopifyHeaders(), body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    warn(`Create failed: ${JSON.stringify(err.errors || err)}`);
    return null;
  }
  return (await res.json()).product;
}

async function updateShopifyProduct(productId, payload) {
  // On updates we only refresh core fields + inventory, not images (avoids duplicates)
  const { images, metafields, ...rest } = payload.product;
  const res = await fetch(`${shopifyBase()}/products/${productId}.json`, {
    method: 'PUT', headers: shopifyHeaders(),
    body: JSON.stringify({ product: rest }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    warn(`Update failed (${productId}): ${JSON.stringify(err.errors || err)}`);
  }
}

async function updateVariantInventory(variantId, quantity) {
  const vRes = await fetch(`${shopifyBase()}/variants/${variantId}.json`, { headers: shopifyHeaders() });
  if (!vRes.ok) return;
  const { variant } = await vRes.json();

  const locRes = await fetch(`${shopifyBase()}/locations.json`, { headers: shopifyHeaders() });
  const { locations } = await locRes.json();
  // Target the "3169 Warehouse" location specifically
  const location = locations?.find(l => l.name === '3169 Warehouse') || locations?.[0];
  const locationId = location?.id;
  if (!locationId) {
    warn(`Location "3169 Warehouse" not found — skipping inventory update for variant ${variantId}`);
    return;
  }

  await fetch(`${shopifyBase()}/inventory_levels/set.json`, {
    method: 'POST', headers: shopifyHeaders(),
    body: JSON.stringify({
      inventory_item_id: variant.inventory_item_id,
      location_id:       locationId,
      available:         quantity,
    }),
  });
}

// ─── MAIN ──────────────────────────────────────────────────────────────────────

async function run() {
  const forceFullSync = process.argv.includes('--full');

  // Validate env vars
  const required = ['REWIX_BASE_URL','REWIX_API_KEY','REWIX_PASSWORD','SHOPIFY_STORE','SHOPIFY_TOKEN'];
  const missing  = required.filter(k => !process.env[k]);
  if (missing.length) {
    console.error(`❌  Missing environment variables: ${missing.join(', ')}`);
    console.error('    Fill in your .env file and try again.');
    process.exit(1);
  }

  if (!ANTHROPIC_API_KEY) {
    warn('ANTHROPIC_API_KEY not set — products will be imported without SEO optimisation.');
    warn('Add it to your .env file to enable Claude SEO generation.');
  }

  // Determine sync mode
  let since = null;
  if (!forceFullSync && fs.existsSync(LAST_UPDATE_FILE)) {
    since = fs.readFileSync(LAST_UPDATE_FILE, 'utf8').trim();
    log(`Incremental sync from ${since}`);
  } else {
    log('Full catalog sync');
  }

  // Fetch from Rewix
  const rewixData = await fetchRewixProducts(since);
  const products  = rewixData.pageItems || [];

  if (products.length === 0) {
    log('No products to sync. Already up to date!');
    if (rewixData.lastUpdate) fs.writeFileSync(LAST_UPDATE_FILE, rewixData.lastUpdate);
    return;
  }

  // Build Shopify index (to detect new vs existing)
  const { skuToProductId, modelIdToData } = await loadShopifyIndex();

  let created = 0, updated = 0, skipped = 0, failed = 0;

  for (let i = 0; i < products.length; i++) {
    const rp         = products[i];
    const firstModel = rp.models?.[0];

    // Match strategy 1: native Rewix SKU (e.g. "GD6423_36")
    let existingId = firstModel?.code ? skuToProductId.get(firstModel.code) : null;

    // Match strategy 2: RewixSync app format "REWIXSYNCRM-{modelId}"
    if (!existingId && firstModel?.id) {
      existingId = modelIdToData.get(firstModel.id)?.productId || null;
      if (existingId) log(`  🔗 Matched via RewixSync model ID ${firstModel.id} → Shopify product ${existingId}`);
    }

    const isNew = !existingId;

    try {
      let seo = null;

      if (isNew && ANTHROPIC_API_KEY) {
        // Generate SEO content for new products only
        seo = await generateSEOContent(rp);
        await sleep(CLAUDE_DELAY);
      }

      const payload = buildShopifyPayload(rp, seo);

      if (isNew) {
        const newProduct = await createShopifyProduct(payload);
        if (newProduct) {
          for (const v of newProduct.variants || []) {
            if (v.sku) skuToProductId.set(v.sku, newProduct.id);
          }
          created++;
          if (seo) log(`  ✨ Created + SEO optimised: ${payload.product.title}`);
        } else {
          failed++;
        }
      } else {
        // Existing product — update stock and core fields only (no SEO rewrite)
        await updateShopifyProduct(existingId, payload);
        for (const m of rp.models || []) {
          // Try native SKU first, then RewixSync model ID
          const vid = skuToProductId.get(m.code)
                   || modelIdToData.get(m.id)?.variantId;
          if (vid) {
            await updateVariantInventory(vid, m.availability ?? 0);
            await sleep(200);
          }
        }
        updated++;
      }

    } catch (err) {
      warn(`Error syncing ${rp.code}: ${err.message}`);
      failed++;
    }

    // Progress every 10 products
    if ((i + 1) % 10 === 0 || i === products.length - 1) {
      log(`Progress: ${i + 1}/${products.length} | ✅ created:${created} updated:${updated} skipped:${skipped} ❌ failed:${failed}`);
    }

    await sleep(SHOPIFY_DELAY);
  }

  // Save timestamp for next incremental sync
  if (rewixData.lastUpdate) {
    fs.writeFileSync(LAST_UPDATE_FILE, rewixData.lastUpdate);
    log(`Saved lastUpdate: ${rewixData.lastUpdate}`);
  }

  log(`\n✅  Sync complete — created: ${created} (SEO optimised), updated: ${updated}, failed: ${failed}`);
}

run().catch(err => {
  console.error('\n❌  Fatal error:', err.message);
  process.exit(1);
});
