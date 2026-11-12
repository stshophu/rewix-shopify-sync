/**
 * Rewix (Spazio Romanelli) retail pricing for the Siebentaschen shop.
 *
 * Decided 12 Nov 2026 — replaces the flat cost-plus formula
 * ((cost + 15) * 1.19 / 0.75), which ignored the retail price and sold most
 * items 45–65 % below RRP.
 *
 * New rule, per variant:
 *   1. Target  = RRP × brand-tier share
 *        strong brands  → 70 % of RRP  (≈ 30 % off)
 *        default        → 60 % of RRP  (≈ 40 % off)
 *        slower brands  → 55 % of RRP  (≈ 45 % off)
 *   2. Floor   = at least MIN_PROFIT € profit per order after cost, shipping
 *                and VAT ((cost + shipping + MIN_PROFIT) × VAT), and never
 *                below the old 25 %-margin price.
 *   3. Cap     = never more than 90 % of RRP (always ≥ 10 % off).
 *      The 25 %-margin floor beats the cap (up to full RRP); the MIN_PROFIT
 *      floor does not — on low-RRP items the 10 %-off rule wins.
 *
 * Tune the brand lists / numbers below; brand matching is case-insensitive.
 */

const SHIPPING    = 15.0;   // € per order, same as before
const VAT         = 1.19;
const MARGIN      = 0.25;   // old formula — now only the hard floor
const MIN_PROFIT  = 35.0;   // € minimum profit per item (soft floor)
const MAX_SHARE   = 0.90;   // never above 90 % of RRP

const SHARE_STRONG  = 0.70;
const SHARE_DEFAULT = 0.60;
const SHARE_SLOW    = 0.55;

const STRONG_BRANDS = [
  'Moose Knuckles', 'Amiri', 'Max Mara', "Tod's", 'Hogan', 'Herno',
  'Moncler', 'Stone Island', 'C.P. Company', 'Canada Goose', 'Golden Goose',
  'Prada', 'Miu Miu', 'Gucci', 'Valentino', 'Valentino Garavani', 'Saint Laurent',
  'Balenciaga', 'Burberry', 'Dolce & Gabbana', 'Versace', 'Fendi',
  'Bottega Veneta', 'Loewe', 'Celine', 'Givenchy', 'Balmain', 'Chloé',
  'Alexander McQueen', 'Jacquemus', 'Off-White', 'Palm Angels', 'Dsquared2',
  'Maison Margiela', 'Brunello Cucinelli', 'Loro Piana', 'Thom Browne',
  'Max Mara Weekend', "'S Max Mara",
];

const SLOW_BRANDS = [
  'Patrizia Pepe', 'Refrigiwear', 'Cristina Effe', 'Bagutta',
  'Mirella Matteini', 'Alpha Studio', 'Suns', 'MC2 Saint Barth',
];

const norm = s => String(s || '').trim().toLowerCase();
const STRONG = new Set(STRONG_BRANDS.map(norm));
const SLOW   = new Set(SLOW_BRANDS.map(norm));

/** RRP share for a brand. Fabric-mill products ("Loro Piana Fabric") are never "strong". */
function brandShare(brand, { isFabric = false } = {}) {
  const b = norm(brand);
  if (isFabric || /\b(fabric|tessuto)\b/.test(b)) return SHARE_DEFAULT;
  if (STRONG.has(b)) return SHARE_STRONG;
  if (SLOW.has(b))   return SHARE_SLOW;
  return SHARE_DEFAULT;
}

/** Round up to .99 (158.20 → 158.99). */
function up99(p) {
  if (p <= 0) return 0;
  const c = Math.floor(p) + 0.99;
  return Math.abs(p - c) < 1e-9 ? p : (c < p ? c + 1 : c);
}
/** Round down to .99 (158.20 → 157.99). */
function down99(p) {
  const c = Math.floor(p) - 0.01;
  return Math.abs(p - (Math.floor(p) + 0.99)) < 1e-9 ? p : c;
}

/**
 * @param {object} a
 * @param {number} a.cost  supplier cost (Rewix taxable), €
 * @param {number|null} a.rrp  Italian retail price (Rewix streetPrice), €
 * @param {string} a.brand
 * @param {boolean} [a.isFabric]
 * @returns {{ price:number|null, reviewReason:null|'no-cost'|'unprofitable', share:number|null }}
 */
function priceRewix({ cost, rrp, brand, isFabric = false }) {
  if (!(Number.isFinite(cost) && cost > 0)) return { price: null, reviewReason: 'no-cost', share: null };

  const hardFloor = (cost + SHIPPING) * VAT / (1 - MARGIN);
  const softFloor = (cost + SHIPPING + MIN_PROFIT) * VAT;

  // No RRP in the feed → floors only (no tier, no cap).
  if (!(Number.isFinite(rrp) && rrp > 0)) {
    return { price: up99(Math.max(hardFloor, softFloor)), reviewReason: null, share: null };
  }

  const share  = brandShare(brand, { isFabric });
  const target = rrp * share;
  const cap    = rrp * MAX_SHARE;

  let raw = Math.min(Math.max(target, softFloor, hardFloor), cap);
  let price = up99(raw);
  if (price > cap) price = down99(cap);

  // Hard floor (old 25 % margin) wins over the 10 %-off cap, up to full RRP.
  if (price < hardFloor - 0.01) price = Math.min(up99(hardFloor), rrp);

  const reviewReason = price < hardFloor - 0.01 ? 'unprofitable' : null;
  return { price: Math.round(price * 100) / 100, reviewReason, share };
}

module.exports = { priceRewix, brandShare, SHIPPING, VAT, MIN_PROFIT, MAX_SHARE };
