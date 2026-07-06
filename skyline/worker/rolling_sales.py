"""rolling_sales.py — NYC DOF Rolling Sales (usep-8jbt) sqft/units fill, ported to Postgres.

PORT NOTE (2026-07-02): the enrichment rules are UNCHANGED from the proven original
(preserved verbatim in rolling_sales.py.legacy): address-level match, use a value only
when ALL matching Rolling Sales rows AGREE (consistent()), NEVER overwrite an existing
value, a >20% disagreement with an existing value is FLAGGED needs_review (never changed),
and condo classes (R*) are ignored. ONLY storage changed:
  * read base.pkl / write out.pkl           ->  read target deals + write fills in Postgres
  * rolling_done.pkl checkpoint             ->  rolling_ledger table (store.mark_rolling_done)
  * manual PPU/PPSF recompute               ->  automatic (deals.ppu/ppsf are GENERATED columns,
                                                so filling units/sqft recomputes them for free)
  * Parse Status='needs_review' on conflict ->  deals.parse_status + a review_queue row

The Rolling Sales fetch is injectable (fetch_fn) so the port is testable against Postgres
with deterministic data.
"""
import os, sys, re, time, random, traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

import requests
from acris_enrich import BOROUGH_CODE, canon_street, split_address
from worker import store

URL = "https://data.cityofnewyork.us/resource/usep-8jbt.json"
HDRS = {"User-Agent": "Mozilla/5.0"}


def fetch_candidates(num, tok, boro_code):
    """Unchanged Rolling Sales query (SoQL quote-escaping preserved)."""
    num_esc, tok_esc = str(num).replace("'", "''"), str(tok).replace("'", "''")
    p = {"$select": "address,gross_square_feet,total_units,building_class_at_time_of,sale_price",
         "$where": f"borough='{boro_code}' AND address like '{num_esc} %{tok_esc}%'",
         "$limit": "50"}
    r = requests.get(URL, params=p, headers=HDRS, timeout=30)
    r.raise_for_status()
    return r.json()


def consistent(values):
    vals = {int(float(v)) for v in values if v and float(v) > 0}
    return vals.pop() if len(vals) == 1 else None


def find_targets(conn, batch, only_deal_ids=None):
    """Deals missing sqft or units, NYC borough, not already in the rolling ledger.
    only_deal_ids restricts the scan (targeted re-runs / isolated tests)."""
    where_ids = "AND d.deal_id = ANY(%s::uuid[])" if only_deal_ids else ""
    params = [list(BOROUGH_CODE.keys())] + ([[str(x) for x in only_deal_ids]] if only_deal_ids else [])
    with conn.cursor() as cur:
        cur.execute(f"""
            SELECT d.deal_id, p.address_raw, p.borough, d.sqft, d.units
            FROM deals d JOIN properties p USING (property_id)
            WHERE (d.sqft IS NULL OR d.units IS NULL)
              AND p.borough = ANY(%s) {where_ids}
            ORDER BY d.sale_date DESC NULLS LAST""", params)
        cols = [c[0] for c in cur.description]
        rows = [dict(zip(cols, r)) for r in cur.fetchall()]
    ids = store.rolling_not_done(conn, [r["deal_id"] for r in rows])
    idset = set(ids)
    return [r for r in rows if r["deal_id"] in idset][:batch]


def run(conn=None, fetch_fn=None, batch=400, sleep=True, only_deal_ids=None):
    fetch_fn = fetch_fn or fetch_candidates
    own = conn is None
    conn = conn or store.connect()
    run_id = store.start_run(conn, "rolling-sales")
    conn.commit()
    stats = {"targets": 0, "sqft_filled": 0, "units_filled": 0,
             "conflict_flagged": 0, "ambiguous": 0, "nohit": 0}
    try:
        targets = find_targets(conn, batch, only_deal_ids=only_deal_ids)
        stats["targets"] = len(targets)
        for t in targets:
            store.mark_rolling_done(conn, t["deal_id"])
            num, name = split_address(t["address_raw"])
            toks = [x for x in (name or "").split() if len(x) > 2]
            if not num or not toks:
                stats["nohit"] += 1
                conn.commit()
                continue
            try:
                cands = fetch_fn(num, max(toks, key=len), BOROUGH_CODE[t["borough"]])
            except Exception:
                # transient fetch error: don't consume the ledger slot
                store_unmark(conn, t["deal_id"])
                conn.commit()
                continue
            cands = [c for c in cands
                     if canon_street(re.sub(r"^\S+\s+", "", c.get("address", ""))) == name
                     and not str(c.get("building_class_at_time_of", "")).upper().startswith("R")]
            if not cands:
                stats["nohit"] += 1
                conn.commit()
                continue
            sf = consistent(c.get("gross_square_feet") for c in cands)
            un = consistent(c.get("total_units") for c in cands)
            if sf is None and un is None:
                stats["ambiguous"] += 1
                conn.commit()
                continue
            _apply_fill(conn, t, sf, un, stats)
            conn.commit()
            if sleep:
                time.sleep(random.uniform(0.05, 0.15))
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


def store_unmark(conn, deal_id):
    with conn.cursor() as cur:
        cur.execute("DELETE FROM rolling_ledger WHERE deal_id=%s", (deal_id,))


def _apply_fill(conn, t, sf, un, stats):
    """Fill-only; >20% disagreement with an existing value is flagged, never overwritten.
    deals.ppu/ppsf are generated, so they recompute automatically when units/sqft change."""
    notes = []
    with conn.cursor() as cur:
        if t["sqft"] is None and sf:
            cur.execute("UPDATE deals SET sqft=%s, updated_at=now() WHERE deal_id=%s AND sqft IS NULL",
                        (sf, t["deal_id"]))
            if cur.rowcount:
                stats["sqft_filled"] += 1
                notes.append(f"sqft {sf}")
        elif t["sqft"] is not None and sf and abs(sf - t["sqft"]) / max(sf, t["sqft"]) > 0.20:
            cur.execute("UPDATE deals SET parse_status='needs_review', updated_at=now() WHERE deal_id=%s",
                        (t["deal_id"],))
            store.flag_review(conn, "deal", t["deal_id"], "sqft_conflict",
                              {"address": t["address_raw"], "existing_sqft": t["sqft"], "rolling_sqft": sf})
            stats["conflict_flagged"] += 1
            notes.append(f"sqft conflict: has {t['sqft']} vs RollingSales {sf}")
        if t["units"] is None and un:
            cur.execute("UPDATE deals SET units=%s, updated_at=now() WHERE deal_id=%s AND units IS NULL",
                        (un, t["deal_id"]))
            if cur.rowcount:
                stats["units_filled"] += 1
                notes.append(f"units {un}")
        if notes:
            cur.execute(
                "UPDATE deals SET notes = trim(both ' |' from coalesce(notes,'') || %s), updated_at=now() WHERE deal_id=%s",
                (" | RollingSales(usep-8jbt): " + ", ".join(notes), t["deal_id"]))


if __name__ == "__main__":
    batch = int(sys.argv[sys.argv.index("--batch") + 1]) if "--batch" in sys.argv else 400
    print("ROLLING SALES:", run(batch=batch))
