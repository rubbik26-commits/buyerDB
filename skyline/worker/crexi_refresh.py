"""crexi_refresh.py — optional Python Crexi/Apify refresh path.

This keeps the production scraper runtime in Python with the rest of the worker
pipeline. It is intentionally optional: if APIFY_TOKEN / APIFY_CREXI_ACTOR are
not configured, the job returns a skipped/not-configured summary instead of
pretending it ran.

The records are active listing intelligence, not deed-confirmed closed sales, so
rows are merged as source_system='crexi' with parse_status='needs_review'. The
canonical write path remains worker.sbi_store.merge_deal(), which means the
same exclusion ledger, residential gate, dedupe, and review behavior applies.
"""
from __future__ import annotations

import os
import sys
import time
import json
import traceback
from typing import Any, Dict, Iterable, Optional

import requests

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from shared.normalize import normalize_address
from worker import sbi_store as store

APIFY_API = "https://api.apify.com/v2"
DEFAULT_WAIT_SECONDS = int(os.environ.get("CREXI_WAIT_SECONDS", "120"))
DEFAULT_MAX_ITEMS = int(os.environ.get("CREXI_MAX_ITEMS", "1000"))

BORO_BY_COUNTY = {
    "KINGS": "Brooklyn",
    "NEW YORK": "Manhattan",
    "QUEENS": "Queens",
    "BRONX": "Bronx",
    "RICHMOND": "Staten Island",
}
BORO_BY_CITY = {
    "BROOKLYN": "Brooklyn",
    "NEW YORK": "Manhattan",
    "MANHATTAN": "Manhattan",
    "QUEENS": "Queens",
    "BRONX": "Bronx",
    "STATEN ISLAND": "Staten Island",
    "LONG ISLAND CITY": "Queens",
    "ASTORIA": "Queens",
    "FLUSHING": "Queens",
    "JAMAICA": "Queens",
}
ASSET_MAP = {
    "Retail": "Retail",
    "Office": "Office",
    "Industrial": "Industrial",
    "Mixed Use": "Mixed-Use",
    "Multifamily": "Multifamily",
    "Land": "Development Site",
    "Self Storage": "Storage",
    "Hospitality": "Hotel",
    "Special Purpose": "Special Purpose",
    "Senior Living": "Multifamily",
}
EXCLUDE_TYPES = {"Business for Sale", "Note/Loan"}


def _headers(token: str) -> Dict[str, str]:
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


def _num(value: Any) -> Optional[float]:
    try:
        if value in (None, ""):
            return None
        n = float(str(value).replace("$", "").replace(",", ""))
        return n if n > 0 else None
    except (TypeError, ValueError):
        return None


def _first(*values: Any) -> Optional[str]:
    for v in values:
        if v is None:
            continue
        s = str(v).strip()
        if s:
            return s
    return None


def _location(item: Dict[str, Any]) -> Dict[str, Any]:
    return item.get("location") or item.get("property", {}).get("location") or {}


def _borough(loc: Dict[str, Any]) -> Optional[str]:
    county = str(loc.get("county") or "").upper().replace(" COUNTY", "").strip()
    city = str(loc.get("city") or "").upper().strip()
    return BORO_BY_COUNTY.get(county) or BORO_BY_CITY.get(city)


def _asset_type(item: Dict[str, Any]) -> Optional[str]:
    raw_types = item.get("property", {}).get("property_types") or item.get("property_types") or []
    if isinstance(raw_types, str):
        raw_types = [raw_types]
    types = [t for t in raw_types if t and t not in EXCLUDE_TYPES]
    if not types:
        return None
    return ASSET_MAP.get(types[0], "Commercial")


def _listing_id(item: Dict[str, Any]) -> Optional[str]:
    return _first(
        item.get("listing", {}).get("listing_id"),
        item.get("record_id"),
        item.get("id"),
        item.get("source_context", {}).get("external_ids", {}).get("crexi_listing_id"),
    )


def _source_url(item: Dict[str, Any]) -> Optional[str]:
    return _first(
        item.get("source_context", {}).get("listing_url"),
        item.get("entity", {}).get("url"),
        item.get("url"),
    )


def _address(item: Dict[str, Any], loc: Dict[str, Any], listing_id: str) -> str:
    return _first(loc.get("address"), loc.get("full_address"), item.get("entity", {}).get("title")) or f"Crexi listing {listing_id}"


def _to_candidate(item: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    loc = _location(item)
    borough = _borough(loc)
    if not borough:
        return None
    asset = _asset_type(item)
    if not asset:
        return None
    listing_id = _listing_id(item)
    if not listing_id:
        return None
    address = _address(item, loc, listing_id)
    price = _num((item.get("pricing") or {}).get("asking_price") or item.get("asking_price") or item.get("price"))
    updated = _first((item.get("listing") or {}).get("updated_at"), item.get("updated_at"), item.get("date"))
    post_date = updated[:10] if updated and len(updated) >= 10 else None
    real_types = item.get("property", {}).get("property_types") or []
    if isinstance(real_types, str):
        real_types = [real_types]
    return {
        "address": address,
        "borough": borough,
        "market": (str(loc.get("city") or borough).strip().lower() or borough.lower()),
        "sale_date": None,
        "post_date": post_date,
        "asset_type": asset,
        "sale_price": price,
        "units": None,
        "sqft": _num(item.get("building_size") or item.get("sqft")),
        "source_system": "crexi",
        "source_url": _source_url(item),
        "shortcode": f"CREXI-{listing_id}",
        "acris_doc_id": None,
        "confidence": 55,
        "parse_status": "needs_review",
        "notes": "Crexi active listing intelligence (asking price, not deed-confirmed closing)"
                 + (f" | {', '.join(map(str, real_types))}" if real_types else ""),
        "bldg_class": None,
    }


def _start_actor(token: str, actor: str, wait_seconds: int) -> Dict[str, Any]:
    payload = {
        "deal_type": "buy",
        "location": "New York, NY",
        "publication_date": "365_days",
        "listing_status": ["active_listing"],
    }
    url = f"{APIFY_API}/acts/{actor}/runs?waitForFinish={wait_seconds}"
    r = requests.post(url, headers=_headers(token), json=payload, timeout=wait_seconds + 30)
    data = r.json() if r.text else {}
    if not r.ok:
        raise RuntimeError(f"Apify actor start failed HTTP {r.status_code}: {json.dumps(data)[:500]}")
    return data.get("data") or data


def _dataset_items(token: str, dataset_id: str, max_items: int) -> Iterable[Dict[str, Any]]:
    offset = 0
    while offset < max_items:
        limit = min(1000, max_items - offset)
        r = requests.get(
            f"{APIFY_API}/datasets/{dataset_id}/items",
            headers=_headers(token),
            params={"limit": limit, "offset": offset},
            timeout=90,
        )
        if not r.ok:
            raise RuntimeError(f"Apify dataset fetch failed HTTP {r.status_code}: {r.text[:500]}")
        batch = r.json()
        if not isinstance(batch, list) or not batch:
            break
        for item in batch:
            if isinstance(item, dict):
                yield item
        if len(batch) < limit:
            break
        offset += len(batch)


def run(conn=None, dataset_id: Optional[str] = None, limit: Optional[int] = None, wait_seconds: int = DEFAULT_WAIT_SECONDS):
    token = os.environ.get("APIFY_TOKEN") or os.environ.get("APIFY_API_TOKEN")
    actor = os.environ.get("APIFY_CREXI_ACTOR")
    if not token or not actor:
        return {"status": "skipped_not_configured", "reason": "APIFY_TOKEN/APIFY_CREXI_ACTOR not set", "merged": 0}

    own = conn is None
    conn = conn or store.connect()
    run_id = store.start_run(conn, "crexi-refresh")
    conn.commit()
    stats = {
        "actor_started": False,
        "dataset_id": dataset_id,
        "dataset_items": 0,
        "nyc_candidates": 0,
        "merged": 0,
        "duplicate": 0,
        "rejected_excluded": 0,
        "rejected_banned_type": 0,
        "rejected_one_two_family": 0,
        "rejected_condo_class": 0,
        "skipped_non_nyc_or_invalid": 0,
        "errors": 0,
    }
    try:
        if not dataset_id:
            actor_run = _start_actor(token, actor, wait_seconds)
            stats["actor_started"] = True
            stats["actor_run_id"] = actor_run.get("id")
            stats["actor_status"] = actor_run.get("status")
            dataset_id = actor_run.get("defaultDatasetId")
            stats["dataset_id"] = dataset_id
        if not dataset_id:
            raise RuntimeError("No Apify dataset id returned for Crexi run")

        max_items = min(limit or DEFAULT_MAX_ITEMS, DEFAULT_MAX_ITEMS)
        for item in _dataset_items(token, dataset_id, max_items):
            stats["dataset_items"] += 1
            cand = _to_candidate(item)
            if not cand:
                stats["skipped_non_nyc_or_invalid"] += 1
                continue
            stats["nyc_candidates"] += 1
            result = store.merge_deal(conn, cand)
            key = result.status if result.status in stats else "errors"
            stats[key] = stats.get(key, 0) + 1
            conn.commit()

        store.finish_run(conn, run_id, "success", stats)
        conn.commit()
        return stats
    except Exception:
        store.finish_run(conn, run_id, "failed", stats, error=traceback.format_exc()[:2000])
        conn.commit()
        raise
    finally:
        if own:
            conn.close()


if __name__ == "__main__":
    print("CREXI REFRESH:", run(limit=int(os.environ["CREXI_LIMIT"]) if os.environ.get("CREXI_LIMIT") else None))
