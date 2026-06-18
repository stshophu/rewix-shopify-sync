# Rewix → Shopify Product Sync

Automatically syncs your supplier's Rewix catalog into your Shopify store.
**Products only — no orders.**

---

## What it does

| Feature | Detail |
|---|---|
| **Full sync** | Downloads the entire Rewix catalog on first run |
| **Incremental sync** | On every subsequent run, only downloads products that changed in Rewix (saves time) |
| **Creates products** | New Rewix products are created in Shopify with all details |
| **Updates products** | Existing products get updated title, description, price, stock |
| **Inventory sync** | Variant stock levels are kept in sync |
| **Variants** | Each Rewix model (size + color combination) becomes a Shopify variant |
| **Images** | Product images are pulled from Rewix and added to Shopify |
| **Metadata** | Rewix product code, HS code, and country of origin saved as metafields |
| **Pricing** | Every variant priced at a 25% margin from the feed's real cost (`m.taxable`/`m.bestTaxable`), capped at RRP |
| **Titles** | Built from a validated IT→EN dictionary translator (`translate.cjs`), not raw Rewix text |

If a product's cost is missing from the feed, or the formula can't clear 25%
margin even at full RRP, the product is created/updated as a **draft** and
tagged `needs-price-review` (no cost data) or `rewix-unprofitable` (priced,
but can't hit margin) so nothing goes live at a guessed or losing price.

---

## Prerequisites

- **Node.js 18 or newer** — download from https://nodejs.org (choose LTS version)
- A **Rewix API Key** from your supplier
- A **Shopify Custom App** with product write permissions

---

## Step 1 — Get your Rewix API Key

Contact your supplier's account manager and ask for your **API Key**.
It will be used as the username for all API calls.
Your password is the same as your account password on the supplier website.

---

## Step 2 — Create a Shopify Custom App

1. Go to your Shopify Admin → **Settings** (bottom left)
2. Click **Apps and sales channels**
3. Click **Develop apps** (top right) → **Create an app**
4. Give it a name like "Rewix Sync"
5. Click **Configure Admin API scopes** and enable:
   - `write_products`
   - `read_products`
   - `write_inventory`
   - `read_inventory`
   - `read_locations`
6. Click **Save**, then click **Install app**
7. Click **Reveal token once** and copy the token that starts with `shpat_…`
   ⚠️ Save this token — it is only shown once!

---

## Step 3 — Set up the project

Open a Terminal (on Mac: press `Cmd + Space`, type Terminal).

```bash
# Navigate to this folder
cd path/to/rewix-shopify-sync

# Install the one dependency
npm install

# Create your credentials file
cp .env.example .env
```

Now open the `.env` file in any text editor (Notepad, TextEdit, VS Code)
and fill in your credentials. It looks like this:

```
REWIX_BASE_URL=https://www.yoursupplier.com
REWIX_API_KEY=your_api_key
REWIX_PASSWORD=your_password
SHOPIFY_STORE=siebentaschen.myshopify.com
SHOPIFY_TOKEN=shpat_xxxxxxxxxxxx
```

---

## Step 4 — Run the sync

**First run (full catalog download):**
```bash
npm run sync:full
```

**Subsequent runs (only what changed):**
```bash
npm run sync
```

You will see progress in the terminal like:
```
[2024-01-15T10:00:00.000Z] Full catalog sync
[2024-01-15T10:00:02.000Z] Fetching Rewix catalog (full)…
[2024-01-15T10:00:05.000Z] Rewix returned 1240 products (lastUpdate: 2024-01-15T09:55:00Z)
[2024-01-15T10:00:08.000Z] Building Shopify product index…
[2024-01-15T10:00:12.000Z] Progress: 25/1240 | ✅ created:23 updated:2 ❌ failed:0
...
[2024-01-15T10:45:00.000Z] ✅  Sync complete — created: 1198, updated: 42, failed: 0
```

---

## Step 5 — Schedule automatic syncs (optional)

Rewix updates their catalog every 15 minutes.
To run the sync automatically, use your operating system's task scheduler:

**Mac/Linux (cron):**
```bash
crontab -e
```
Add this line to run every hour:
```
0 * * * * cd /path/to/rewix-shopify-sync && node sync.js >> sync.log 2>&1
```

**Windows (Task Scheduler):**
- Open Task Scheduler → Create Basic Task
- Set trigger: Daily, repeat every 1 hour
- Action: Start a program → `node` with argument `C:\path\to\rewix-shopify-sync\sync.js`

---

## Filtering by brand or category (optional)

If you only want to sync specific brands or categories, you can add filters to the
`fetchRewixProducts` function in `sync.js`. For example, to sync only bags:

Find this line in `sync.js`:
```javascript
const params = new URLSearchParams({
  v:               'TEAL',
  acceptedlocales: LOCALES,
});
```

And add a tag filter:
```javascript
const params = new URLSearchParams({
  v:               'TEAL',
  acceptedlocales: LOCALES,
  tag_4:           'bags',    // category filter
  // tag_1:        'Gucci',   // brand filter
  // tag_26:       'women',   // gender filter
});
```

Available category values: `clothing`, `accessories`, `bags`, `cosmetics`, `underwear`, `shoes`
Available gender values: `kids`, `women`, `unisex`, `men`

---

## Troubleshooting

| Error | Fix |
|---|---|
| `Missing environment variables` | Check your `.env` file — make sure all values are filled in |
| `HTTP 401` from Rewix | Wrong API key or password |
| `HTTP 403` from Shopify | Wrong token or missing API scopes |
| `HTTP 412` from Rewix | Your `since` timestamp is more than 4 hours old — run `npm run sync:full` once |
| Products created but no images | Check `REWIX_IMAGE_BASE` in your `.env` |

Delete `.last_sync_timestamp` to force a full sync on the next run.

---

## File overview

```
rewix-shopify-sync/
├── sync.js                  ← Main sync script
├── .env.example             ← Credentials template (copy to .env)
├── .env                     ← Your actual credentials (never share this!)
├── package.json             ← Project config
├── .last_sync_timestamp     ← Auto-created; stores last sync time for incremental updates
└── README.md                ← This file
```
