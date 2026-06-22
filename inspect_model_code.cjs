/**
 * inspect_model_code.cjs
 * ─────────────────────────────────────────────────────────────
 * READ-ONLY DIAGNOSTIC. Talks to the Rewix API only — makes ZERO requests
 * to Shopify, reads or writes nothing. Safe to run any number of times.
 *
 * Purpose: confirm (or rule out) whether m.code values for a given product
 * actually have whitespace/encoding inconsistencies, instead of assuming
 * the hypothesis is correct. Run this BEFORE re-uploading sync.js or
 * triggering another full sync.
 *
 * Usage:
 *   node inspect_model_code.cjs m4c06t
 *   (pass the bare code, or any substring of a title, to search for)
 */

require('dotenv').config();

const REWIX_BASE_URL = process.env.REWIX_BASE_URL;
const REWIX_API_KEY  = process.env.REWIX_API_KEY;
const REWIX_PASSWORD = process.env.REWIX_PASSWORD;
const LOCALES = 'en_US,de_DE';

const basicAuth = () => Buffer.from(`${REWIX_API_KEY}:${REWIX_PASSWORD}`).toString('base64');

function hexDump(str) {
  return [...str].map(ch => `${ch}(0x${ch.codePointAt(0).toString(16)})`).join(' ');
}

async function run() {
  const search = (process.argv[2] || '').toLowerCase();
  if (!search) {
    console.error('Usage: node inspect_model_code.cjs <code-or-title-substring>');
    process.exit(1);
  }
  if (!REWIX_BASE_URL || !REWIX_API_KEY || !REWIX_PASSWORD) {
    console.error('❌ Missing REWIX_BASE_URL / REWIX_API_KEY / REWIX_PASSWORD env vars.');
    process.exit(1);
  }

  console.log(`Fetching full Rewix catalog, searching for code/title containing "${search}"…\n`);
  const params = new URLSearchParams({ v: 'TEAL', acceptedlocales: LOCALES });
  const url = `${REWIX_BASE_URL}/restful/export/api/products.json?${params}`;
  const res = await fetch(url, {
    headers: { Authorization: `Basic ${basicAuth()}`, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Rewix API error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const products = data.pageItems || [];

  let matches = 0;
  for (const rp of products) {
    for (const m of rp.models || []) {
      const code = m.code || '';
      const title = rp.modelLocalizations?.title?.en_US?.value || '';
      if (code.toLowerCase().includes(search) || title.toLowerCase().includes(search)) {
        matches++;
        console.log('─'.repeat(60));
        console.log(`Rewix product id: ${rp.id}`);
        console.log(`Title: ${title}`);
        console.log(`Model id: ${m.id}`);
        console.log(`code raw value:    "${code}"`);
        console.log(`code length:       ${code.length} characters`);
        console.log(`code byte/char dump: ${hexDump(code)}`);
        console.log(`code === code.trim(): ${code === code.trim()}`);
        console.log(`size raw value:    "${m.size}"`);
      }
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log(`Total matches: ${matches}`);
  if (matches === 0) {
    console.log('No matches — try a different search term (e.g. part of the title).');
  } else {
    console.log('\nIf you ran this command twice in a row and any "code raw value" or');
    console.log('"code byte/char dump" differs between runs for the SAME model id,');
    console.log('that confirms the Rewix API itself returns inconsistent data —');
    console.log('not something fixable on our end beyond trimming defensively.');
  }
}

run().catch(err => {
  console.error('❌ Fatal error:', err.message);
  process.exit(1);
});
