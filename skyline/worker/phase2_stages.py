"""phase2_stages.py — fill missing buyer/seller on existing deals from ACRIS,
ported to Postgres.

PORT NOTE (2026-07-02): the matching logic is UNCHANGED from the proven original
(preserved verbatim in phase2_stages.py.legacy): the legals lookup (street number +
borough + street-name token, then canon_street exact match), the deed-master fetch,
the 3%-amount + date-distance tiebreak for priced rows, and the no-price unique-deed
(≥$200K within 240d) rule. ONLY storage changed:
  * target rows: read /home/claude/cleaned.pkl  ->  deals missing a buyer/seller
    party (non-ACRIS source, NYC borough) queried from Postgres
  * inter-stage pickle checkpoints  ->  in-process sequence
  * matches.pkl handed to apply_enrichment  ->  apply_enrichment.apply_fill called
    directly (store.apply_acris_party_fill — the amount gate)

Fetchers are injectable (lookup_fn / masters_fn / parties_fn) so the port is testable
against Postgres with deterministic data.
"""
import os, sys, traceback, datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from acris_enrich import (soql, soql_all, LEGALS, MASTER, DEED_TYPES, BOROUGH_CODE,
                          canon_street, split_address, SUF, DIR)
from worker import store, apply_enrichment

NYC_BOROUGHS = ("Manhattan", "Brooklyn", "Queens", "Bronx", "Staten Island")
GENERIC = set(SUF.values()) | set(DIR.values()) | {"THE", "OF", "LA", "DE"}


def key_token(name):
    toks = [t for t in (name or "").split() if t not in GENERIC]
    return max(toks, key=len) if toks else None


def _ddist(sale_date, m):
    dd = (m.get("document_date") or "")[:10]
    if not sale_date or not dd:
        return 9999
    try:
        return abs((datetime.date.fromisoformat(str(sale_date)[:10])
                    - datetime.date.fromisoformat(dd)).days)
    except ValueError:
        return 9999


# ── target discovery (Postgres) ──────────────────────────────────────────────
def find_targets(conn, limit=None):
    """Deals missing a buyer OR seller party, non-ACRIS source, NYC borough."""
    sql = f"""
        SELECT d.deal_id, p.address_raw, p.borough, d.sale_price, d.sale_date
        FROM deals d JOIN properties p USING (property_id)
        WHERE d.source_system <> 'acris'
          AND p.borough = ANY(%s)
          AND (NOT EXISTS (SELECT 1 FROM deal_parties dp WHERE dp.deal_id=d.deal_id AND dp.role='buyer')
               OR NOT EXISTS (SELECT 1 FROM deal_parties dp WHERE dp.deal_id=d.deal_id AND dp.role='seller'))
        ORDER BY d.sale_date DESC NULLS LAST
        {'LIMIT %s' if limit else ''}"""
    params = [list(NYC_BOROUGHS)] + ([limit] if limit else [])
    with conn.cursor() as cur:
        cur.execute(sql, params)
        cols = [c[0] for c in cur.description]
        return [dict(zip(cols, r)) for r in cur.fetchall()]


# ── legals lookup (unchanged SoQL + canon_street match) ──────────────────────
def lookup_legals(address, borough, soql_fn=None):
    soql_fn = soql_fn or soql
    num, name = split_address(address)
    tok = key_token(name or "")
    if not num or not tok or borough not in BOROUGH_CODE:
        return None
    try:
        rows = soql_fn(LEGALS, {
            "$select": "document_id,street_number,street_name,borough,block,lot,property_type",
            "$where": f"street_number='{num}' AND borough='{BOROUGH_CODE[borough]}' "
                      f"AND street_name like '%{tok}%'",
            "$limit": "5000"})
    except Exception:
        return None
    hits = [r for r in rows if canon_street(r.get("street_name")) == name]
    if not hits:
        return None
    return {r["document_id"] for r in hits}, hits[0]


def fetch_deed_masters(doc_ids, masters_fn=None):
    masters_fn = masters_fn or (lambda ids: {
        m["document_id"]: m for m in soql_all(
            MASTER, f"document_id IN ({','.join(repr(d) for d in ids)}) AND doc_type IN {DEED_TYPES}",
            "document_id ASC", select="document_id,document_amt,document_date,doc_type")})
    return masters_fn(list(doc_ids)) if doc_ids else {}


# ── match (unchanged rule) ───────────────────────────────────────────────────
def match_target(target, docs, masters):
    """Returns (doc_id, master) or None. Same 3%/date-distance + no-price rules."""
    deeds = [masters[d] for d in docs if d in masters and float(masters[d].get("document_amt") or 0) > 0]
    if not deeds:
        return None
    sd = target["sale_date"]
    price = target["sale_price"]
    if price is not None:
        price = float(price)
        cands = [m for m in deeds if abs(float(m["document_amt"]) - price) / price <= 0.03]
        if not cands:
            return None
        best = min(cands, key=lambda m: _ddist(sd, m))
        if _ddist(sd, best) > 400:
            return None
        return best["document_id"], best
    cands = sorted([m for m in deeds if float(m["document_amt"]) >= 200000 and _ddist(sd, m) <= 240],
                   key=lambda m: _ddist(sd, m))
    if len(cands) == 1 or (len(cands) > 1 and _ddist(sd, cands[0]) < _ddist(sd, cands[1])):
        return cands[0]["document_id"], cands[0]
    return None


def run(conn=None, lookup_fn=None, masters_fn=None, parties_fn=None, limit=None):
    lookup_fn = lookup_fn or (lambda addr, boro: lookup_legals(addr, boro))
    own = conn is None
    conn = conn or store.connect()
    run_id = store.start_run(conn, "phase2-enrichment")
    conn.commit()
    stats = {"targets": 0, "legals_hit": 0, "matched": 0, "filled": 0,
             "gated_out": 0, "no_legals": 0, "no_match": 0}
    try:
        targets = find_targets(conn, limit=limit)
        stats["targets"] = len(targets)
        for t in targets:
            found = lookup_fn(t["address_raw"], t["borough"])
            if not found:
                stats["no_legals"] += 1
                continue
            docs, _legal0 = found
            stats["legals_hit"] += 1
            masters = fetch_deed_masters(docs, masters_fn=masters_fn)
            match = match_target(t, docs, masters)
            if not match:
                stats["no_match"] += 1
                continue
            doc_id, deed = match
            stats["matched"] += 1
            res = apply_enrichment.apply_fill(conn, t["deal_id"], doc_id, deed, fetch_parties_fn=parties_fn)
            if res.get("status") == "filled":
                stats["filled"] += 1
            elif res.get("status") == "gated_out":
                stats["gated_out"] += 1
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
    print("PHASE2 ENRICHMENT:", run())
