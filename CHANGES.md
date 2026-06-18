# CHANGES — 2026-06-18

This update fixes pricing, titles, categories, and variant SKUs in the
Rewix → Shopify sync, and adds an operator safety guard.

## sync.js

1. **25% margin pricing from real feed cost.**
   Price is now computed as `(cost + €15 shipping) × 1.19 / 0.75`, rounded to
   `.99`, capped at RRP (streetPrice). Cost comes straight from the Rewix feed
   (`m.taxable` / `m.bestTaxable`), which is present on 100% of models — so
   pricing no longer depends on Shopify's stored `inventory_item.cost`.
   - Replaces the old `suggestedPrice ?? streetPrice ?? 0` line, which wrote
     literal €0 whenever Rewix sent `suggestedPrice: 0` (≈27% of models) because
     `??` doesn't fall through on 0.
   - Models with no usable cost → product drafted + tagged `needs-price-review`.
   - Items that can't clear margin even at RRP → drafted + tagged
     `rewix-unprofitable`.

2. **English titles at import.**
   Titles built by the validated dictionary translator (`translate.cjs`):
   Brand + Gender + translated Name + Color. Uses the English locale tag values
   (`tagValueEN`). No more Italian titles, no paid Claude SEO calls.

3. **English categories / product types.**
   `category` and `subcategory` Rewix tags are Italian with no en_US locale, so
   they're now translated via `translateCategory` / `translateSubcategory`.
   (`type` tag is empty in the feed and intentionally unused.)

4. **Unique SKUs per size.**
   Rewix gives every size of a product the SAME `m.code`, which collapsed
   variants and spawned duplicates in Shopify. SKU is now `${code}-${size}`.
   The Shopify index and matcher are size-tolerant (they index both the full
   SKU and the bare code) so this migration does NOT duplicate the catalog on
   the first run.

5. **`manual-hold` guard.**
   Any product tagged `manual-hold` keeps its status untouched by the sync
   (price/title/inventory still refresh; the tag is preserved). Use this to pull
   a product manually without the hourly sync flipping it back to active.

## translate.cjs
   Added `translateCategory`, `translateSubcategory`, and the
   CATEGORY_EN / SUBCATEGORY_EN dictionaries (handles the `abiiti` feed typo).

## .github/workflows/main.yml
   Added a `concurrency` guard so overlapping hourly runs can't collide
   (a full sync takes ~45-50 min, close to the hourly cadence).

## New helper (not run by the workflow)
   `audit_duplicates_and_collapsed.cjs` — read-only audit that reports duplicate
   products and collapsed-variant products. Run manually after the first synced
   run to plan duplicate cleanup.

## Recommended rollout
1. Push these files to `main`.
2. Manually trigger the workflow (Actions → Run workflow) and watch the log.
   Expect a high `updated:` count on the first run (titles + prices change
   across the catalog). `created` should stay low.
3. After one full run, re-run `audit_duplicates_and_collapsed.cjs` to plan
   duplicate cleanup against the now-corrected catalog.
