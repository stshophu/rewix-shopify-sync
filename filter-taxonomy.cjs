/**
 * Maps a product onto the storefront filter system:
 *   filter.category    -> Accessories | Bags | Clothing | Shoes
 *   filter.subcategory -> one of the existing values below
 *
 * Only values that already exist in the shop are ever produced, so the
 * storefront filter does not grow new, near-duplicate entries.
 * Anything that cannot be placed confidently returns null for that field
 * (never a guess) and is listed in the backfill report.
 */

// subcategory -> category (taken from the live filter data)
const SUB_TO_CAT = {
  // Shoes
  'Ankle Boots': 'Shoes', 'Boots': 'Shoes', 'Espadrilles': 'Shoes', 'Flats': 'Shoes',
  'Heeled Sandals': 'Shoes', 'Loafers': 'Shoes', 'Mules': 'Shoes', 'Pumps': 'Shoes',
  'Sandals': 'Shoes', 'Slippers': 'Shoes', 'Sneakers': 'Shoes',
  // Bags
  'Backpacks': 'Bags', 'Clutches': 'Bags', 'Crossbody Bags': 'Bags', 'Handbags': 'Bags',
  'Pouches': 'Bags', 'Shoulder Bags': 'Bags', 'Travel Bags': 'Bags',
  // Accessories
  'Belts': 'Accessories', 'Card Holders': 'Accessories', 'Gloves': 'Accessories',
  'Hats': 'Accessories', 'Scarves': 'Accessories', 'Socks': 'Accessories',
  'Sunglasses': 'Accessories', 'Ties': 'Accessories', 'Wallets': 'Accessories',
  // Clothing
  'Blazers': 'Clothing', 'Coats': 'Clothing', 'Down Jackets': 'Clothing', 'Dresses': 'Clothing',
  'Jackets': 'Clothing', 'Jeans': 'Clothing', 'Jumpsuits': 'Clothing', 'Knitwear': 'Clothing',
  'Polo Shirts': 'Clothing', 'Shirts': 'Clothing', 'Shorts': 'Clothing', 'Skirts': 'Clothing',
  'Suits': 'Clothing', 'Sweaters': 'Clothing', 'Sweatshirts': 'Clothing', 'Swimwear': 'Clothing',
  'T-Shirts': 'Clothing', 'Tops': 'Clothing', 'Tracksuits': 'Clothing', 'Trousers': 'Clothing',
  'Underwear': 'Clothing', 'Vests': 'Clothing',
};

// Source wording (Rewix English subcategory, Channable product type, title keyword)
// -> existing subcategory. Lower-case keys.
const ALIASES = {
  'sneakers': 'Sneakers', 'sneaker': 'Sneakers', 'trainers': 'Sneakers',
  'ankle boots': 'Ankle Boots', 'boots': 'Boots', 'boot': 'Boots',
  'sandals': 'Sandals', 'sandal': 'Sandals', 'heel sandals': 'Heeled Sandals',
  'heeled sandals': 'Heeled Sandals', 'flip-flops': 'Sandals', 'flip flops': 'Sandals',
  'pumps heels': 'Pumps', 'pumps': 'Pumps', 'pump': 'Pumps', 'heels': 'Pumps',
  'flats': 'Flats', 'ballerinas': 'Flats', 'loafers': 'Loafers', 'loafer': 'Loafers',
  'mules': 'Mules', 'slippers': 'Slippers', 'espadrilles': 'Espadrilles', 'espadrillas': 'Espadrilles',
  'backpacks': 'Backpacks', 'backpack': 'Backpacks', 'small backpacks': 'Backpacks',
  'clutches': 'Clutches', 'clutch': 'Clutches',
  'crossbody bags': 'Crossbody Bags', 'crossbody': 'Crossbody Bags', 'crossbody bag': 'Crossbody Bags',
  'handbags': 'Handbags', 'handbag': 'Handbags', 'tote bag': 'Handbags', 'tote': 'Handbags',
  'top handle': 'Handbags', 'bucket bag': 'Handbags', 'shopping bags': 'Handbags', 'shopper': 'Handbags',
  'pouches': 'Pouches', 'pouch': 'Pouches',
  'shoulder bags': 'Shoulder Bags', 'shoulder bag': 'Shoulder Bags', 'hobo': 'Shoulder Bags',
  'travel bags': 'Travel Bags', 'luggage': 'Travel Bags', 'duffle': 'Travel Bags',
  'belts': 'Belts', 'belt': 'Belts',
  'card holders': 'Card Holders', 'card holder': 'Card Holders', 'holder': 'Card Holders',
  'coin purses': 'Wallets', 'wallets': 'Wallets', 'wallet': 'Wallets',
  'gloves': 'Gloves', 'glove': 'Gloves',
  'hats': 'Hats', 'hat': 'Hats', 'cap': 'Hats', 'caps': 'Hats', 'beanie': 'Hats',
  'scarves': 'Scarves', 'scarf': 'Scarves', 'foulard': 'Scarves',
  'socks': 'Socks', 'sunglasses': 'Sunglasses', 'ties': 'Ties', 'bow ties': 'Ties',
  'blazers': 'Blazers', 'blazer': 'Blazers', 'formal jacket': 'Blazers', 'formal jackets': 'Blazers',
  'coats': 'Coats', 'coat': 'Coats', 'peacoat': 'Coats', 'cape': 'Coats',
  'down jackets': 'Down Jackets', 'down jacket': 'Down Jackets',
  'dresses': 'Dresses', 'dress': 'Dresses',
  'jackets': 'Jackets', 'jacket': 'Jackets', 'bomber': 'Jackets',
  'jeans': 'Jeans', 'jumpsuits': 'Jumpsuits', 'jumpsuit': 'Jumpsuits',
  'knitwear': 'Knitwear', 'knit': 'Knitwear', 'cardigans': 'Knitwear', 'cardigan': 'Knitwear',
  'polo shirts': 'Polo Shirts', 'polo': 'Polo Shirts',
  'shirts': 'Shirts', 'shirt': 'Shirts', 'blouses': 'Shirts', 'blouse': 'Shirts',
  'shorts': 'Shorts', 'bermuda': 'Shorts', 'skirts': 'Skirts', 'skirt': 'Skirts',
  'suits': 'Suits', 'sweaters': 'Sweaters', 'sweater': 'Sweaters', 'jumper': 'Sweaters',
  'sweatshirts': 'Sweatshirts', 'sweatshirt': 'Sweatshirts', 'hoodie': 'Sweatshirts',
  'swimwear': 'Swimwear', 't-shirts': 'T-Shirts', 't-shirt': 'T-Shirts',
  't-shirts & tops': 'T-Shirts', 'tops': 'Tops', 'top': 'Tops',
  'tracksuits': 'Tracksuits', 'tracksuit': 'Tracksuits',
  'trousers': 'Trousers', 'trouser': 'Trousers', 'pants': 'Trousers', 'joggers': 'Trousers',
  'jogger': 'Trousers', 'leggings': 'Trousers', 'leggins': 'Trousers',
  'underwear': 'Underwear', 'vests': 'Vests', 'vest': 'Vests', 'gilet': 'Vests',
};

const CATEGORY_ALIASES = {
  shoes: 'Shoes', scarpe: 'Shoes', footwear: 'Shoes',
  clothing: 'Clothing', abbigliamento: 'Clothing', apparel: 'Clothing',
  bags: 'Bags', bag: 'Bags', borse: 'Bags',
  accessories: 'Accessories', accessory: 'Accessories', accessori: 'Accessories',
  home: 'Accessories', casa: 'Accessories',
};

const norm = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

function lookupSub(text) {
  return ALIASES[norm(text)] || null;
}

// Last-resort: look for a known garment/bag noun in the product title.
// Longest keys first so "crossbody bag" wins over "bag".
const TITLE_KEYS = Object.keys(ALIASES)
  .filter(k => k.length >= 4 && !['top', 'cap', 'hat', 'polo', 'knit', 'pants', 'heels'].includes(k))
  .sort((a, b) => b.length - a.length);

function subFromTitle(title) {
  const t = ' ' + norm(title) + ' ';
  for (const k of TITLE_KEYS) {
    if (t.includes(' ' + k + ' ') || t.includes(' ' + k + 's ')) return ALIASES[k];
  }
  return null;
}

/**
 * @param {{productType?:string, title?:string, tags?:string[], rewixSub?:string}} p
 * @returns {{category:string|null, subcategory:string|null, source:string}}
 */
function classify(p) {
  const tags = p.tags || [];
  // 1) subcategory: rewix.subcategory -> product type (minus gender prefix) -> title
  const type = String(p.productType || '').replace(/^(men|women|woman|man|junior|kids|unisex)\s+/i, '');
  let sub = lookupSub(p.rewixSub);
  let source = sub ? 'rewix.subcategory' : '';
  if (!sub && (sub = lookupSub(type))) source = 'product_type';
  if (!sub && (sub = subFromTitle(p.title))) source = 'title';

  // 2) category: from the subcategory, else tags, else product type
  let category = sub ? SUB_TO_CAT[sub] : null;
  if (!category) {
    for (const t of tags) {
      const c = CATEGORY_ALIASES[norm(t)];
      if (c) { category = c; source = source || 'tag'; break; }
    }
  }
  if (!category) {
    category = CATEGORY_ALIASES[norm(type)] || null;
    if (category) source = source || 'product_type';
  }
  return { category, subcategory: sub, source: source || 'none' };
}

function genderFromTags(tags) {
  for (const t of tags || []) {
    const k = norm(t);
    if (k === 'woman' || k === 'women') return 'Women';
    if (k === 'man' || k === 'men') return 'Men';
    if (k === 'junior' || k === 'kids') return 'Junior';
    if (k === 'unisex') return 'Unisex';
  }
  return null;
}

module.exports = { classify, genderFromTags, SUB_TO_CAT };
