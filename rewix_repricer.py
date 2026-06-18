#!/usr/bin/env python3
"""
rewix_repricer.py — Reprice all RewixSync products for direct Siebentaschen sales.

Formula:  price = (cost + 15) * 1.19 / 0.75        (~1.587x, 25% margin after 19% VAT)
          capped at compare_at_price (never above RRP)

Unprofitable products (RRP can't reach target margin) -> set to draft + tag 'rewix-unprofitable'

Usage:
  python3 rewix_repricer.py            # dry run (default, no changes)
  python3 rewix_repricer.py --commit   # apply changes

Requires: pip3 install requests
"""

import sys
import os
import time
import requests

# ── CONFIG ──────────────────────────────────────────────────────────────
SHOP = "siebentaschen.myshopify.com"
TOKEN = os.environ.get("SHOPIFY_TOKEN")   # set this in your shell / .env — never hardcode it here
if not TOKEN:
    sys.exit("Missing SHOPIFY_TOKEN environment variable. Set it before running this script.")
API = f"https://{SHOP}/admin/api/2024-10"

SHIPPING = 15.0
VAT = 1.19
TARGET_MARGIN = 0.25          # 25% gross margin after VAT
DIVISOR = 1 - TARGET_MARGIN   # 0.75
ROUND_TO_99 = True            # 158.73 -> 158.99 style pricing

COMMIT = "--commit" in sys.argv
HEADERS = {"X-Shopify-Access-Token": TOKEN, "Content-Type": "application/json"}


def log(msg):
    print(msg, flush=True)


def req(method, url, **kw):
    """Request with rate-limit retry."""
    for attempt in range(6):
        r = requests.request(method, url, headers=HEADERS, timeout=30, **kw)
        if r.status_code == 429:
            wait = float(r.headers.get("Retry-After", 2))
            time.sleep(wait)
            continue
        if r.status_code >= 500:
            time.sleep(2 ** attempt)
            continue
        return r
    r.raise_for_status()
    return r


def round_price(p):
    if not ROUND_TO_99:
        return round(p, 2)
    import math
    return math.floor(p) + 0.99 if p % 1 != 0.99 else p


def fetch_rewix_products():
    """Paginate all active+draft products, keep those tagged RewixSync."""
    products = []
    url = f"{API}/products.json?limit=250&fields=id,title,status,tags,variants"
    while url:
        r = req("GET", url)
        batch = r.json().get("products", [])
        for p in batch:
            tags = [t.strip() for t in (p.get("tags") or "").split(",")]
            if "RewixSync" in tags:
                products.append(p)
        # cursor pagination via Link header
        link = r.headers.get("Link", "")
        url = None
        for part in link.split(","):
            if 'rel="next"' in part:
                url = part[part.find("<") + 1: part.find(">")]
        time.sleep(0.6)
        log(f"  fetched... {len(products)} RewixSync products so far")
    return products


def fetch_costs(inventory_item_ids):
    """Batch-fetch cost per inventory item (100 per call)."""
    costs = {}
    ids = list(inventory_item_ids)
    for i in range(0, len(ids), 100):
        chunk = ",".join(str(x) for x in ids[i:i + 100])
        r = req("GET", f"{API}/inventory_items.json?ids={chunk}&limit=100")
        for item in r.json().get("inventory_items", []):
            c = item.get("cost")
            costs[item["id"]] = float(c) if c else None
        time.sleep(0.6)
    return costs


def main():
    log(f"Mode: {'COMMIT' if COMMIT else 'DRY RUN'}")
    log("Fetching RewixSync products...")
    products = fetch_rewix_products()
    log(f"Total RewixSync products: {len(products)}")

    inv_ids = {v["inventory_item_id"] for p in products for v in p["variants"]}
    log(f"Fetching costs for {len(inv_ids)} inventory items...")
    costs = fetch_costs(inv_ids)

    repriced = 0
    skipped_no_cost = 0
    unprofitable = []
    unchanged = 0

    for p in products:
        product_unprofitable = True
        variant_updates = []

        for v in p["variants"]:
            cost = costs.get(v["inventory_item_id"])
            if cost is None or cost <= 0:
                skipped_no_cost += 1
                product_unprofitable = False  # can't judge -> don't draft
                continue

            min_viable = (cost + SHIPPING) * VAT / DIVISOR
            compare_at = float(v.get("compare_at_price") or 0)
            current = float(v.get("price") or 0)

            new_price = round_price(min_viable)
            if compare_at > 0 and new_price > compare_at:
                new_price = compare_at  # cap at RRP

            # profitable if capped price still reaches min_viable (small tolerance)
            if new_price >= min_viable - 0.01:
                product_unprofitable = False

            if abs(new_price - current) >= 0.01:
                variant_updates.append((v["id"], current, new_price))
            else:
                unchanged += 1

        if product_unprofitable and p["variants"]:
            unprofitable.append(p)
            log(f"  ⚠️  UNPROFITABLE: {p['title']} (id {p['id']})")
            if COMMIT:
                tags = (p.get("tags") or "") + ", rewix-unprofitable"
                req("PUT", f"{API}/products/{p['id']}.json",
                    json={"product": {"id": p["id"], "status": "draft", "tags": tags}})
                time.sleep(0.6)
            continue

        for vid, old, new in variant_updates:
            log(f"  {p['title'][:50]:50}  €{old:>8.2f} -> €{new:>8.2f}")
            if COMMIT:
                req("PUT", f"{API}/variants/{vid}.json",
                    json={"variant": {"id": vid, "price": f"{new:.2f}"}})
                time.sleep(0.6)
            repriced += 1

    log("\n=== DONE ===")
    log(f"Variants repriced:     {repriced}")
    log(f"Already correct:       {unchanged}")
    log(f"Skipped (no cost):     {skipped_no_cost}")
    log(f"Unprofitable products: {len(unprofitable)} {'(set to draft)' if COMMIT else '(would be drafted)'}")
    if not COMMIT:
        log("\nDry run only. Re-run with --commit to apply.")


if __name__ == "__main__":
    main()
