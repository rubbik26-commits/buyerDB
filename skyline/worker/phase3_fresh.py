"""phase3_fresh.py — fresh-window ACRIS deed ingest, ported to Postgres.

PORT NOTE (2026-07-02): the ACRIS domain logic below is UNCHANGED from the proven
original (preserved verbatim in phase3_fresh.py.legacy) — the fresh-window masters
query, the isBadAddress rule, the $1M price floor, the classify() residential/condo
gate, buyer==seller suppression, and the confidence scoring are byte-for-byte the
same decisions. ONLY the storage layer changed:
  * inter-stage pickle checkpoints  -> in-process sequence (one Actions job)
  * dedupe against enriched.pkl      -> store.merge_deal (acris_doc_id UNIQUE +
                                        addr/price/date), so no pre-dedupe needed
  * pickle new_rows.pkl              -> store.merge_deal per row, then parties via
                                        store.apply_acris_party_fill (AMOUNT GATE;
                                        for ACRIS-native deeds price==document_amt
                                        so the gate passes, and the acris_requires_gate
                                        CHECK is satisfied through the sole write path)

Fetchers are injectable (fetch_masters_fn / fetch_detail_fn / fetch_pluto_fn) so the
port is testable against Postgres with deterministic data, exactly like
run_incremental. Defaults call the live ACRIS/PLUTO functions in acris_enrich.
"""
import os, sys, traceback
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

import re
from acris_enrich import (soql_all, MASTER, DEED_TYPES, chunked, build_bbl,
                          fetch_pluto, fetch_parties, fetch_legals, classify,
                          CODE_BOROUGH, norm_entity, is_placeholder)
from worker import store

PRICE_FLOOR = 1_000_000        # preserved
RECENT_DAYS = 120              # preserved
MASTER_CAP = 4000             # preserved


# ── live fetchers (unchanged ACRIS queries) ──────────────────────────────────
def fetch_masters_live(recent_days=RECENT_DAYS):
    since = (datetime.now(timezone.utc) - timedelta(days=recent_days)).strftime("%Y-%m-%d")
    where = (f"doc_type IN {DEED_TYPES} AND document_amt >= {PRICE_FLOOR} "
             f"AND recorded_datetime >= '{since}T00:00:00.000'")
    return soql_all(MASTER, where, "recorded_datetime DESC", page=1000, cap=MASTER_CAP)


def fetch_detail_live(doc_ids):
    """Parties + legals for the masters (the proven shaping lives in acris_enrich)."""
    return fetch_parties(doc_ids), fetch_legals(doc_ids)


def fetch_pluto_live(legals):
    bbls = []
    for lg in legals.values():
        b = build_bbl(lg.get("borough"), lg.get("block"), lg.get("lot"))
        if b:
            bbls.append(b)
    return fetch_pluto(bbls)


# ── candidate construction (domain logic preserved verbatim) ─────────────────
def build_candidate(m, parties, legals, pluto):
    """Returns (merge_row, party_info) or (None, reason) — same accept/reject
    rules and confidence scoring as the original build stage. The reason keeps
    run stats honest: missing legals / bad address / sub-floor price used to be
    lumped into rejected_class."""
    doc = m["document_id"]
    lg = legals.get(doc)
    if not lg:
        return None, "no_legals"
    num = (lg.get("street_number") or "").strip()
    name = (lg.get("street_name") or "").strip()
    if not num or not name:
        return None, "bad_address"
    if not re.match(r"^\d", num):           # isBadAddress rule from the Deno ingester
        return None, "bad_address"
    price = float(m.get("document_amt") or 0)
    if price < PRICE_FLOOR:
        return None, "below_floor"
    bbl = build_bbl(lg.get("borough"), lg.get("block"), lg.get("lot"))
    pl = pluto.get(str(int(bbl))) if bbl else None
    units = int(pl["unitstotal"]) if pl and pl.get("unitstotal") else None
    asset = classify(pl.get("bldgclass") if pl else None, lg.get("property_type"), units)
    if not asset:                            # residential/condo classes rejected here
        return None, "rejected_class"
    boro = CODE_BOROUGH.get(str(lg.get("borough") or "").strip())
    addr = " ".join(x for x in [num, name.title(), boro, "NY"] if x)
    pt = parties.get(doc, {})
    buyer = None if is_placeholder(pt.get("buyer")) else pt.get("buyer")
    seller = None if is_placeholder(pt.get("seller")) else pt.get("seller")
    if buyer and seller and norm_entity(buyer) == norm_entity(seller):
        seller = None
    sqft = int(pl["bldgarea"]) if pl and pl.get("bldgarea") else None
    conf = 40 + (20 if buyer else 0) + (15 if seller else 0) \
        + (15 if pl and pl.get("bldgclass") else 0) + (10 if sqft else 0)
    sale_date = (m.get("document_date") or "")[:10] or None
    merge_row = {
        "address": addr, "borough": boro, "market": boro.lower() if boro else None,
        "sale_date": sale_date, "post_date": (m.get("recorded_datetime") or "")[:10] or None,
        "asset_type": asset, "sale_price": price, "units": units, "sqft": sqft,
        "source_system": "acris",
        "source_url": f"https://a836-acris.nyc.gov/DS/DocumentSearch/DocumentDetail?doc_id={doc}",
        "shortcode": f"ACRIS-{doc}", "acris_doc_id": doc,
        "confidence": min(100, conf),
        "parse_status": "ok" if conf >= 60 else "needs_review",
        "notes": f"ACRIS {doc} | fresh-window ingest | class {(pl or {}).get('bldgclass','?')} | BBL {bbl}",
        "bldg_class": (pl or {}).get("bldgclass"),
    }
    party_info = {"doc": doc, "amount": price, "date": sale_date,
                  "buyer": buyer, "seller": seller,
                  "buyer_address": pt.get("buyer_address"), "seller_address": pt.get("seller_address")}
    return (merge_row, party_info), None


def run(conn=None, fetch_masters_fn=None, fetch_detail_fn=None, fetch_pluto_fn=None,
        recent_days=RECENT_DAYS, limit=None):
    fetch_masters_fn = fetch_masters_fn or (lambda: fetch_masters_live(recent_days))
    fetch_detail_fn = fetch_detail_fn or fetch_detail_live
    fetch_pluto_fn = fetch_pluto_fn or fetch_pluto_live
    own = conn is None
    conn = conn or store.connect()
    run_id = store.start_run(conn, "phase3-fresh")
    conn.commit()
    stats = {"masters": 0, "candidates": 0, "merged": 0, "parties_filled": 0,
             "duplicate": 0, "rejected_class": 0, "rejected_excluded": 0,
             "rejected_one_two_family": 0, "rejected_condo_class": 0, "gated_out": 0,
             "no_legals": 0, "bad_address": 0, "below_floor": 0, "other": 0}
    try:
        masters = list(fetch_masters_fn())
        if limit:
            masters = masters[:limit]
        stats["masters"] = len(masters)
        doc_ids = sorted({m["document_id"] for m in masters})
        parties, legals = fetch_detail_fn(doc_ids)
        pluto = fetch_pluto_fn(legals)

        for m in masters:
            built, reject_reason = build_candidate(m, parties, legals, pluto)
            if not built:
                stats[reject_reason] = stats.get(reject_reason, 0) + 1
                continue
            merge_row, pinfo = built
            stats["candidates"] += 1
            res = store.merge_deal(conn, merge_row)
            if res.status == "merged":
                stats["merged"] += 1
                fill = store.apply_acris_party_fill(
                    conn, res.deal_id, pinfo["doc"], pinfo["amount"], pinfo["date"],
                    buyer=pinfo["buyer"], seller=pinfo["seller"],
                    buyer_address=pinfo["buyer_address"], seller_address=pinfo["seller_address"])
                if fill.get("status") == "filled":
                    stats["parties_filled"] += 1
                elif fill.get("status") == "gated_out":
                    stats["gated_out"] += 1
            else:
                key = res.status if res.status in stats else "other"
                stats[key] = stats.get(key, 0) + 1  # unknown status must not masquerade as duplicate
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
    print("PHASE3 FRESH:", run())
