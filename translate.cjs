/**
 * translate.cjs
 * ─────────────────────────────────────────────────────────────
 * Italian → English fashion translation, dictionary-based.
 * Built from the actual RewixSync title word-frequency export.
 *
 * Exports:
 *   translatePhrase(str)          → translated string (word by word)
 *   buildTitle({brand, gender, name, color, subcat}) → final product title
 *
 * Philosophy:
 *   - Known IT word  → EN term
 *   - Known EN word  → passed through unchanged
 *   - Junk token     → dropped
 *   - Unknown word   → kept as-is (better partial than wrong)
 */

// ─── GARMENT / PRODUCT NOUNS ────────────────────────────────────────────────
const GARMENTS = {
  giacca: 'Jacket', giacche: 'Jacket',
  pantaloni: 'Trousers', pantalone: 'Trousers',
  felpa: 'Sweatshirt', felpe: 'Sweatshirt',
  maglia: 'Knit', maglie: 'Knit', maglietta: 'T-Shirt', maglione: 'Sweater',
  abito: 'Dress',           // overridden to Suit/Suit-piece by modifiers below
  camicia: 'Shirt', camicie: 'Shirt',
  piumino: 'Down Jacket', piumini: 'Down Jacket',
  dolcevita: 'Turtleneck',
  polo: 'Polo',
  cappotto: 'Coat', cappotti: 'Coat',
  gilet: 'Vest',
  gonna: 'Skirt', gonne: 'Skirt',
  cardigan: 'Cardigan',
  bomber: 'Bomber',
  completo: 'Suit', tuta: 'Tracksuit', tute: 'Tracksuit',
  parka: 'Parka',
  blazer: 'Blazer',
  borsa: 'Bag', borse: 'Bag', pochette: 'Clutch', zaino: 'Backpack',
  cintura: 'Belt', cinture: 'Belt',
  portafoglio: 'Wallet',
  sneakers: 'Sneakers', scarpe: 'Shoes', stivali: 'Boots', stivaletto: 'Ankle Boot',
  cappello: 'Hat', berretto: 'Beanie', beanie: 'Beanie',
  sciarpa: 'Scarf', guanti: 'Gloves',
  costume: 'Swimsuit', boxer: 'Boxer', slip: 'Briefs',
  bermuda: 'Bermuda Shorts', pantaloncini: 'Shorts',
  cravatta: 'Tie', papillon: 'Bow Tie',
  occhiali: 'Glasses', goggles: 'Goggles',
  canotta: 'Tank Top', canottiera: 'Tank Top',
  body: 'Bodysuit', tubino: 'Sheath Dress',
  giubbotto: 'Jacket', giubbino: 'Jacket', giaccone: 'Heavy Jacket',
  trench: 'Trench Coat', impermeabile: 'Raincoat',
  caftano: 'Kaftan',
};

// ─── COLORS (used to recognize+optionally strip color words in the name) ─────
const COLORS = {
  blu: 'Blue', nero: 'Black', nera: 'Black', neri: 'Black', nere: 'Black',
  bianco: 'White', bianca: 'White', bianchi: 'White', bianche: 'White',
  verde: 'Green', verdi: 'Green',
  rosso: 'Red', rossa: 'Red', rossi: 'Red', rosse: 'Red',
  grigio: 'Grey', grigia: 'Grey', grigi: 'Grey', grigie: 'Grey',
  beige: 'Beige', marrone: 'Brown', marroni: 'Brown',
  rosa: 'Pink', viola: 'Purple', azzurro: 'Light Blue', azzurra: 'Light Blue',
  giallo: 'Yellow', gialla: 'Yellow', arancione: 'Orange',
  navy: 'Navy', panna: 'Cream', avorio: 'Ivory', ecru: 'Ecru', ecrù: 'Ecru',
  fantasia: 'Patterned', fantasy: 'Patterned', multicolor: 'Multicolor',
};

// ─── MATERIALS ──────────────────────────────────────────────────────────────
const MATERIALS = {
  cashmere: 'Cashmere', lana: 'Wool', seta: 'Silk', cotone: 'Cotton',
  pelle: 'Leather', lino: 'Linen', nylon: 'Nylon', denim: 'Denim',
  pizzo: 'Lace', misto: 'Blend', velluto: 'Velvet', raso: 'Satin',
  jersey: 'Jersey', tweed: 'Tweed', popeline: 'Poplin',
};

// ─── STYLE / CUT MODIFIERS ──────────────────────────────────────────────────
const MODIFIERS = {
  girocollo: 'Crew Neck', scollo: 'Neckline', collo: 'Neck',
  cappuccio: 'Hooded', zip: 'Zip',
  doppiopetto: 'Double-Breasted', monopetto: 'Single-Breasted',
  gessato: 'Pinstripe', floreale: 'Floral', stampa: 'Print', ricamo: 'Embroidered',
  corta: 'Short', corto: 'Short', lungo: 'Long', lunga: 'Long',
  cropped: 'Cropped', crop: 'Cropped',
  slim: 'Slim', regular: 'Regular', cargo: 'Cargo', stretch: 'Stretch',
  trapuntato: 'Quilted', antivento: 'Windproof', impermeabile: 'Waterproof',
  maniche: 'Sleeve', manica: 'Sleeve', smanicato: 'Sleeveless',
  rever: 'Lapel', costina: 'Ribbed', inglese: 'English Rib',
  micro: 'Micro', maxi: 'Maxi', mini: 'Mini', oversize: 'Oversize',
  swim: 'Swim', notte: 'Night',
};

// ─── FILLERS (dropped) ──────────────────────────────────────────────────────
const FILLERS = new Set(['con','di','da','del','della','in','a','e','il','la','lo',
  'le','i','gli','un','una','uno','per','su','the','and','with']);

// ─── JUNK (dropped: SKU fragments, line/codenames seen in the frequency dump) ─
const JUNK = new Set(['cdfd','cdfu','phw','dsq','dsquared','icon','tag','logo',
  'love','new','all','fit','grand','michelangelo','federico','capolavoro',
  'capolavori','pinko','herno','diagonal','goggles_dummy']);

// English words we accept as-is (already-English tokens in Rewix titles)
const PASSTHROUGH = new Set(['shirt','jacket','top','jeans','polo','bag','denim',
  'shorts','short','swim','blazer','bomber','cardigan','parka','wallet','beanie',
  'sneakers','boxer','cargo','slim','crop','black','white','blue','red','grey',
  'green','navy','pink','brown','medium','large','small','regular','stretch',
  'man','woman','kids']);

// ─── MULTI-WORD PHRASES (applied BEFORE word-splitting) ─────────────────────
// Order matters: longest / most-specific first.
const PHRASES = [
  [/\babito a tre pezzi\b/ig, 'Three-Piece Suit'],
  [/\babito a due pezzi\b/ig, 'Two-Piece Suit'],
  [/\babito intero\b/ig,      'Suit'],
  [/\btre pezzi\b/ig,         'Three-Piece'],
  [/\bdue pezzi\b/ig,         'Two-Piece'],
  [/\bgirocollo\b/ig,         'Crew Neck'],
  [/\btaglio vivo\b/ig,       'Raw Edge'],
  [/\ba pois\b/ig,            'Polka Dot'],
  [/\bpied de poule\b/ig,     'Houndstooth'],
  [/\bscollo a v\b/ig,        'V-Neck'],
  [/\bmezza zip\b/ig,         'Half-Zip'],
  [/\bgamba larga\b/ig,       'Wide-Leg'],
];

// Extra single-word terms surfaced by the leak test
Object.assign(MODIFIERS, {
  jkt: 'Jacket', nuptse: '', sleenker: '', retro: 'Retro', pois: 'Polka Dot',
  taupe: '', vivo: '', taglio: '',
  // surfaced by the 40-product live sample:
  usurato: 'Distressed', usato: 'Distressed', used: 'Distressed',
  effetto: '', paricollo: 'Crew Neck', lupetto: 'Mock Neck',
  elasticizzati: 'Stretch', elasticizzato: 'Stretch',
  imbottita: 'Padded', imbottito: 'Padded',
  tracolla: 'Crossbody', classica: 'Classic', classico: 'Classic',
  costa: '', alto: 'High', tricot: 'Knit', vynil: 'Vinyl',
  paisley: 'Paisley', macro: '', fluo: 'Fluo', months: '', month: '',
  finezza: 'Gauge', acqua: 'Aqua', cenere: 'Ash',
  caffè: 'Coffee', caffe: 'Coffee', fucsia: 'Fuchsia',
  // surfaced by the full 1684-product live run:
  antipioggia: 'Rainproof', traspirante: 'Breathable', antivento: 'Windproof',
  scamosciata: 'Suede', scamosciato: 'Suede', reversibile: 'Reversible',
  smanicata: 'Sleeveless', smanicato: 'Sleeveless',
  eleganti: 'Elegant', elegante: 'Elegant', lucida: 'Glossy', lucido: 'Glossy',
  lucidi: 'Glossy', aderenti: 'Fitted', aderente: 'Fitted',
  zebrato: 'Zebra Print', floreali: 'Floral', siciliana: 'Sicilian',
  pieghe: 'Pleated', palazzo: 'Palazzo', borchiato: 'Studded',
  borchiati: 'Studded', borchie: 'Studded', strappati: 'Ripped',
  strappato: 'Ripped', bielastico: 'Stretch', costine: 'Ribbed',
  costina: 'Ribbed', corte: 'Short', lunghe: 'Long', lunghi: 'Long',
  natura: 'Natural', velluto: 'Velvet', spugna: 'Terry',
  coulisse: 'Drawstring', couisse: 'Drawstring', spacco: 'Slit',
  scollo: '', plissè: 'Pleated', satinato: 'Satin', rasata: 'Plain Knit',
  paiettata: 'Sequined', paillettes: 'Sequins', uncinetto: 'Crochet',
});

// Multi-word phrases that need to come together (added to PHRASES below dynamically)
PHRASES.push(
  [/\bcollo alto\b/ig,    'High Neck'],
  [/\bcosta inglese\b/ig, 'English Rib'],
  [/\beffetto usurato\b/ig,'Distressed'],
  [/\bscollo a v\b/ig,    'V-Neck'],
  [/\bgamba dritta\b/ig,  'Straight-Leg'],
);

const LOOKUP = { ...GARMENTS, ...COLORS, ...MATERIALS, ...MODIFIERS };

function translateWord(raw) {
  const w = raw.toLowerCase().trim();
  if (!w) return null;
  if (FILLERS.has(w)) return null;
  if (JUNK.has(w)) return null;
  if (LOOKUP[w] !== undefined) return LOOKUP[w] || null; // '' means: drop
  if (PASSTHROUGH.has(w)) return w.charAt(0).toUpperCase() + w.slice(1);
  // unknown: keep as-is if it looks like a real word, else drop pure codes
  if (/^[a-zà-ù]+$/i.test(w) && w.length > 2) {
    return w.charAt(0).toUpperCase() + w.slice(1);
  }
  return null; // numbers, sku fragments, single chars
}

function translatePhrase(str) {
  if (!str) return '';
  let s = str;
  for (const [re, rep] of PHRASES) s = s.replace(re, rep);
  const out = [];
  const seen = new Set();
  for (const token of s.split(/[^a-zà-ùA-Z-]+/i)) {
    for (const sub of token.split(/\s+/)) {
      if (!sub) continue;
      const low = sub.toLowerCase();
      // Known Italian/English dictionary word → translate, regardless of source casing
      if (LOOKUP[low] !== undefined || FILLERS.has(low) || JUNK.has(low) || PASSTHROUGH.has(low)) {
        const t = translateWord(sub);
        if (t && !seen.has(t.toLowerCase())) { out.push(t); seen.add(t.toLowerCase()); }
        continue;
      }
      // Clean phrase output from PHRASES (e.g. "Three-Piece") → keep
      const isCleanPhrase = /^[A-Za-z]+(-[A-Za-z]+)*$/.test(sub) && sub.length > 2;
      if (/[A-Z]/.test(sub) || sub.includes('-')) {
        if (isCleanPhrase && !seen.has(low)) { out.push(sub); seen.add(low); }
        continue;
      }
      const t = translateWord(sub);
      if (t && !seen.has(t.toLowerCase())) { out.push(t); seen.add(t.toLowerCase()); }
    }
  }
  return out.join(' ');
}

// Detect a real garment noun in the translated name (singular OR plural)
function hasGarment(translated) {
  const garmentVals = new Set(Object.values(GARMENTS).map(v => v.toLowerCase()).filter(Boolean));
  ['suit','jeans','shorts','swimwear','swimsuit','t-shirt','tank top','track pants',
   'tote bag','pouch','clutch','boot','boots','top','blouse','sweater','sweaters',
   'skirt','skirts','bag','bags','backpack','wallet','belt','belts','polo','dress',
   'cardigan','vest','coat','jacket','shirt','knit','sneakers','hat','beanie',
   'turtleneck','bomber','blazer','leggings','tracksuit','parka','scarf','gloves',
   'briefs','boxer','underwear','handbags','heels','pumps'].forEach(g => garmentVals.add(g));
  const t = translated.toLowerCase();
  for (const g of garmentVals) {
    if (new RegExp(`\\b${g}s?\\b`).test(t)) return true;
  }
  return false;
}

// Suit override: Rewix tags men's suits as "Dress". Fix from the IT title.
const SUIT_RE = /\b(tre pezzi|due pezzi|completo|intero|smoking|doppiopetto)\b/i;

/**
 * Build the final product title.
 *  Format: Brand + Gender + <translated name> + Color
 *  - Subcategory (translated) used only if the name yields no garment noun.
 *  - Color appended once; stripped from the name body to avoid duplication.
 */
function buildTitle({ brand, gender, name, color, subcat }) {
  let body = translatePhrase(name || '');

  // Fall back to translated subcategory ONLY if the name yielded no garment noun
  if (!hasGarment(body) && subcat) {
    const sc = translatePhrase(subcat);
    body = body ? `${body} ${sc}` : sc;
  }

  // Normalize the supplied color tag (may be IT or EN)
  let colorEN = '';
  if (color) {
    const c = color.toLowerCase().trim();
    colorEN = COLORS[c] || (color.charAt(0).toUpperCase() + color.slice(1));
  }

  // Strip color word out of the body so it isn't doubled
  if (colorEN) {
    const re = new RegExp(`\\b${colorEN}\\b`, 'ig');
    body = body.replace(re, '').replace(/\s+/g, ' ').trim();
  }

  const genderEN = gender
    ? gender.charAt(0).toUpperCase() + gender.slice(1).toLowerCase()
    : '';

  // Remove a stray gender word from the body so we don't get "Man Man ..."
  if (genderEN) {
    body = body.replace(new RegExp(`\\b(man|woman|men|women)\\b`, 'ig'), '')
               .replace(/\s+/g, ' ').trim();
  }
  // Tidy: capitalize a leading lowercase t-shirt etc.
  body = body.replace(/\bt-shirt\b/ig, 'T-Shirt');

  // Collapse generic+specific redundancy: "Dress Sheath Dress" → "Sheath Dress",
  // "Short ... Shorts" → drop the bare "Short".
  body = body.replace(/\bDress\b\s+(.*\bDress\b)/i, '$1');
  body = body.replace(/\bShort\b\s+(.*\bShorts\b)/i, '$1');
  body = body.replace(/\s+/g, ' ').trim();

  return [brand, genderEN, body, colorEN]
    .map(s => (s || '').trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

module.exports = { translatePhrase, buildTitle, GARMENTS, COLORS };
