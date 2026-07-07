"""run_incremental.py — the daily worker entrypoint (blueprint §6).

Sequence, matching the daily-incremental.yml design:
  1. discover traded.co deal URLs  (listing pages + NY sitemap)
  2. SUBTRACT the fetch ledger      (rejected fetches store no URL — dataset can't dedupe discovery)
  3. fetch + parse each new URL     (curl_cffi transport; free on a Python host)
  4. merge each candidate           (exclusion ledger + no_residential + class gate + addr/price/doc dedupe)
  5. record every fetch disposition + write a scrape_runs row with stats

The scraper/transport is injectable (discover_fn, fetch_fn) so this runs live in
Actions and deterministically in tests without hitting the network. The merge and
ledger semantics are store.py's — the same code path proven in test_store.py.
"""
import os, sys, traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from worker import store


def _live_discover():
    """Live discovery via the proven traded_scraper (curl_cffi)."""
    import requests
    from traded_scraper import discover_deal_urls
    return discover_deal_urls(requests.Session())


def _live_fetch(url):
    """Live fetch+parse via the proven backfill mapper (structured parse, geo/date logic)."""
    from traded_backfill import fetch_html, map_deal
    row, status = map_deal(fetch_html(url), url)
    return row, status


def _row_to_candidate(row):
    """Adapt a traded_backfill parsed row (its column names) to store.merge_deal's keys.
    NOTE: Buyer/Seller from the parsed page are intentionally NOT written here —
    merge_deal has no party write path, and this GitHub-Actions worker is the
    LEGACY fallback (decisions D-008/D-010). The live pg_cron -> edge-function
    path ingests traded parties through sync_upsert_deals(); parties for
    legacy-merged deals arrive via the amount-gated phase-2 ACRIS fill."""
    if not row:
        return None
    return {
        "address": row.get("Address"), "borough": row.get("Borough"), "market": row.get("Market"),
        "sale_date": row.get("sale_date_iso"), "post_date": None,
        "asset_type": row.get("Asset Type"), "sale_price": row.get("Sale Price"),
        "units": row.get("Units"), "sqft": row.get("Sq Ft"),
        "source_system": "traded", "source_url": row.get("Source URL"),
        "shortcode": row.get("Shortcode"), "acris_doc_id": None,
        "confidence": row.get("Confidence"), "parse_status": row.get("Parse Status") or "ok",
        "notes": row.get("Notes"), "bldg_class": None,
    }


def run(discover_fn=None, fetch_fn=None, limit=None):
    discover_fn = discover_fn or _live_discover
    fetch_fn = fetch_fn or _live_fetch
    conn = store.connect()
    run_id = store.start_run(conn, "daily-incremental")
    conn.commit()
    stats = {"discovered": 0, "new_urls": 0, "fetched": 0, "merged": 0,
             "duplicate": 0, "rejected_excluded": 0, "rejected_one_two_family": 0,
             "rejected_condo_class": 0, "rejected_banned_type": 0, "parse_failed": 0}
    try:
        urls = list(discover_fn())
        stats["discovered"] = len(urls)
        todo = store.urls_not_fetched(conn, urls)          # SUBTRACT the fetch ledger
        conn.commit()
        if limit:
            todo = todo[:limit]
        stats["new_urls"] = len(todo)

        for url in todo:
            try:
                row, status = fetch_fn(url)
            except Exception as e:
                store.record_fetch(conn, url, f"fetch_error:{type(e).__name__}")
                conn.commit()
                stats["parse_failed"] += 1
                continue
            cand = _row_to_candidate(row)
            if not cand or not cand.get("address"):
                store.record_fetch(conn, url, f"no_address:{status}")
                conn.commit()
                stats["parse_failed"] += 1
                continue
            stats["fetched"] += 1
            res = store.merge_deal(conn, cand)
            store.record_fetch(conn, url, res.status)
            conn.commit()
            key = res.status if res.status in stats else "other"
            stats[key] = stats.get(key, 0) + 1  # unknown status must not inflate "merged"

        store.finish_run(conn, run_id, "success", stats)
        conn.commit()
        return stats
    except Exception:
        store.finish_run(conn, run_id, "failed", stats, error=traceback.format_exc()[:2000])
        conn.commit()
        raise
    finally:
        conn.close()


if __name__ == "__main__":
    result = run(limit=int(os.environ["INCREMENTAL_LIMIT"]) if os.environ.get("INCREMENTAL_LIMIT") else None)
    print("INCREMENTAL RUN:", result)
    # non-zero exit if nothing could be discovered (dead-man signal for the workflow)
    sys.exit(0 if result["discovered"] > 0 else 3)
