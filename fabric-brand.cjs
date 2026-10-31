/**
 * "Fabric brand" products: garments made by other (unnamed) manufacturers from
 * cloth woven by a luxury mill, which suppliers list under the mill's name
 * ("Loro Piana Fabric", "L.P. Fabric", "Loro Piana tessuto", "Ermenegildo Zegna Fabric").
 *
 * Selling them as "Loro Piana ..." is misleading brand use — Google Merchant
 * Center flags it as misrepresentation. So the title leads with the garment and
 * names the fabric honestly, the description says plainly who did NOT make it,
 * and the products are tagged so they can be kept out of Google feeds.
 */

const MILLS = [
  { re: /^(loro\s*piana\s*(fabric|tessuto)|l\.?\s*p\.?\s*fabric)$/i, mill: 'Loro Piana' },
  { re: /^(ermenegildo\s*)?zegna\s*(fabric|tessuto)$/i, mill: 'Ermenegildo Zegna' },
];

// Brand prefixes to strip from the start of an existing title.
const PREFIXES = [
  /^loro\s*piana\s*(fabric|tessuto)\s*/i,
  /^l\.?\s*p\.?\s*fabric\s*/i,
  /^(ermenegildo\s*)?zegna\s*(fabric|tessuto)\s*/i,
  /^loro\s*piana\s*/i,
  /^(ermenegildo\s*)?zegna\s*/i,
];

const FABRIC_TAG = 'fabric-brand';
const NO_GOOGLE_TAG = 'no-google';

/** Mill name if `vendor` (or a tag/title hint) marks a fabric-brand product, else null. */
function fabricMill(vendor, { title = '', tags = [] } = {}) {
  const v = String(vendor || '').trim();
  for (const m of MILLS) if (m.re.test(v)) return m.mill;
  // Vendor says the real brand, but title/tags say it's only the fabric.
  const hint = [title, ...(Array.isArray(tags) ? tags : String(tags).split(','))].join(' ');
  if (/^loro\s*piana$/i.test(v) && /(fabric|tessuto)/i.test(hint)) return 'Loro Piana';
  if (/zegna/i.test(v) && /(fabric|tessuto)/i.test(hint)) return 'Ermenegildo Zegna';
  return null;
}

function fabricTitle(title, mill) {
  const suffix = `, made with ${mill} fabric`;
  if (String(title).endsWith(suffix)) return title;
  let rest = String(title || '').trim();
  for (const p of PREFIXES) rest = rest.replace(p, '');
  rest = rest.replace(/\s+/g, ' ').trim();
  if (!rest) rest = 'Garment';
  rest = rest.charAt(0).toUpperCase() + rest.slice(1);
  return `${rest}${suffix}`;
}

function fabricNoteHtml(mill) {
  return `<p class="fabric-brand-note"><em>Made by an independent manufacturer using fabric produced by ${mill}. ` +
         `This is not a ${mill}-branded product and is not made, sold or endorsed by ${mill}.</em></p>`;
}

function fabricBody(bodyHtml, mill) {
  const body = String(bodyHtml || '');
  if (body.includes('fabric-brand-note')) return body;
  return fabricNoteHtml(mill) + body;
}

module.exports = { fabricMill, fabricTitle, fabricBody, FABRIC_TAG, NO_GOOGLE_TAG };
