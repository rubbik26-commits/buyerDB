"""worker/store.py — the pipeline's storage layer: pickle files -> Postgres tables.

Every write invariant lives here, in ONE code path:
  * fetch ledger: discovery must subtract it; every fetch records a disposition
  * exclusion ledger: consulted in EVERY merge (addr_norm+price)
  * residential gate: banned asset types rejected; scraped (non-ACRIS) candidates
    with a DOF class matching 1-2-family/condo are rejected to the exclusion
    ledger — THE FIX for the hole that admitted 30 traded/crexi 1-2-family rows
    (removed with PLUTO evidence 2026-07-02). Candidates with units<=2 and NO
    class evidence are flagged needs_review, never silently admitted or dropped.
  * amount gate: party fills require deed amount within 3% of the deal price
    (or no-price + deed date within 60 days) — apply_enrichment.py semantics
  * never overwrite a non-null field; provenance recorded on every fill
"""
import os, sys, json, datetime
import psycopg2

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
from shared.normalize import (norm_entity, normalize_address, split_address,
                              is_placeholder, entity_type, BANNED_ASSET_TYPES,
                              ONE_TWO_FAMILY_CLASSES, CONDO_BUILDING_CLASSES)

AMOUNT_TOL = 0.03
NO_PRICE_DATE_WINDOW_DAYS = 60


def connect():
    return psycopg2.connect(os.environ["DATABASE_URL"])


# ── fetch ledger ─────────────────────────────────────────────────────────────
def urls_not_fetched(conn, urls):
    """Discovery must subtract the ledger BEFORE fetching (README rule).
    fetch_error dispositions do NOT count as fetched: a Cloudflare 403 or a
    timeout is transport-dependent, not permanent (verified: same URL flips
    403->200) — treating it as done permanently blacklisted the deal."""
    if not urls:
        return []
    with conn.cursor() as cur:
        cur.execute(
            """SELECT url FROM fetch_ledger
               WHERE url = ANY(%s) AND disposition NOT LIKE 'fetch_error:%%'""",
            (list(urls),))
        done = {r[0] for r in cur.fetchall()}
    return [u for u in urls if u not in done]


def record_fetch(conn, url, disposition):
    with conn.cursor() as cur:
        cur.execute(
            """INSERT INTO fetch_ledger (url, disposition) VALUES (%s,%s)
               ON CONFLICT (url) DO UPDATE SET disposition=EXCLUDED.disposition, fetched_at=now()""",
            (url, disposition))


# ── exclusion ledger ─────────────────────────────────────────────────────────
def is_excluded(conn, address, price):
    key = normalize_address(address)
    with conn.cursor() as cur:
        cur.execute("SELECT reason FROM exclusion_ledger WHERE addr_norm=%s AND price=%s",
                    (key, int(price) if price else 0))
        row = cur.fetchone()
    return row[0] if row else None


def add_exclusion(conn, address, price, reason, evidence):
    with conn.cursor() as cur:
        cur.execute(
            """INSERT INTO exclusion_ledger (addr_norm, price, reason, evidence)
               VALUES (%s,%s,%s,%s) ON CONFLICT DO NOTHING""",
            (normalize_address(address), int(price) if price else 0, reason, evidence))


# ── merge ────────────────────────────────────────────────────────────────────
class MergeResult:
    def __init__(self, status, deal_id=None, reason=None):
        self.status, self.deal_id, self.reason = status, deal_id, reason


def merge_deal(conn, row):
    """row keys: address, borough, market, sale_date, post_date, asset_type,
    sale_price, units, sqft, source_system, source_url, shortcode, acris_doc_id,
    confidence, parse_status, notes, bldg_class (optional PLUTO/DOF class).
    Returns MergeResult(status in: merged | rejected_excluded | rejected_banned_type |
    rejected_one_two_family | rejected_condo_class | duplicate)."""
    addr, price = row["address"], row.get("sale_price")

    # 1. exclusion ledger — EVERY merge
    reason = is_excluded(conn, addr, price)
    if reason:
        return MergeResult("rejected_excluded", reason=reason)

    # 2. banned asset types
    if row.get("asset_type") in BANNED_ASSET_TYPES:
        return MergeResult("rejected_banned_type", reason=row["asset_type"])

    # 3. residential class gate (the 2026-07-02 fix): scraped candidates carrying a
    #    building class are checked; 1-2 family and condo classes are rejected AND
    #    written to the exclusion ledger so they can never re-enter.
    cls = (row.get("bldg_class") or "").strip().upper()
    if cls and ONE_TWO_FAMILY_CLASSES.match(cls):
        add_exclusion(conn, addr, price, "one_two_family",
                      f"DOF class {cls} at merge time (source {row.get('source_system')})")
        return MergeResult("rejected_one_two_family", reason=cls)
    if cls and CONDO_BUILDING_CLASSES.match(cls):
        add_exclusion(conn, addr, price, "condo",
                      f"DOF class {cls} at merge time (source {row.get('source_system')})")
        return MergeResult("rejected_condo_class", reason=cls)

    # 4. no class evidence + units<=2 residential-leaning -> admit FLAGGED (never silent)
    parse_status = row.get("parse_status") or "ok"
    notes = row.get("notes") or ""
    if (not cls and row.get("source_system") in ("traded", "crexi", "instagram", "upload")
            and row.get("units") is not None and row["units"] <= 2
            and (row.get("asset_type") or "") in ("Multifamily", "", None)):
        parse_status = "needs_review"
        notes = (notes + " | units<=2 without building-class evidence: possible 1-2 family — review").strip(" |")

    with conn.cursor() as cur:
        # dedupe on acris doc id BEFORE the property upsert: a duplicate must not
        # touch properties.updated_at or create a property row as a side effect
        if row.get("acris_doc_id"):
            cur.execute("SELECT 1 FROM deals WHERE acris_doc_id=%s", (row["acris_doc_id"],))
            if cur.fetchone():
                return MergeResult("duplicate", reason="acris_doc_id")

        # property upsert
        key = normalize_address(addr)
        num, name = split_address(addr)
        cur.execute(
            """INSERT INTO properties (address_raw, address_norm, street_number, street_name_canon, borough, market)
               VALUES (%s,%s,%s,%s,%s,%s)
               ON CONFLICT (address_norm, borough) DO UPDATE SET updated_at=now()
               RETURNING property_id""",
            (addr, key, num, name, row.get("borough"), row.get("market")))
        pid = cur.fetchone()[0]

        # dedupe: addr+price+date (the phase3 keys, now constraints)
        cur.execute(
            """SELECT 1 FROM deals WHERE property_id=%s
               AND sale_price IS NOT DISTINCT FROM %s AND sale_date IS NOT DISTINCT FROM %s""",
            (pid, price, row.get("sale_date")))
        if cur.fetchone():
            return MergeResult("duplicate", reason="addr_price_date")

        cur.execute(
            """INSERT INTO deals (property_id, sale_date, post_date, asset_type, sale_price, units, sqft,
                                  source_system, source_url, shortcode, acris_doc_id, confidence, parse_status, notes)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING deal_id""",
            (pid, row.get("sale_date"), row.get("post_date"), row.get("asset_type"),
             price, row.get("units"), row.get("sqft"), row["source_system"],
             row.get("source_url"), row.get("shortcode"), row.get("acris_doc_id"),
             row.get("confidence"), parse_status, notes or None))
        deal_id = cur.fetchone()[0]
        if parse_status == "needs_review":
            cur.execute(
                """INSERT INTO review_queue (object_type, object_id, issue_class, payload)
                   VALUES ('deal', %s, 'merge_flag', %s)""",
                (str(deal_id), json.dumps({"address": addr, "notes": notes[:400]})))
    return MergeResult("merged", deal_id=deal_id)


# ── party fill (apply_enrichment semantics) ──────────────────────────────────
def amount_gate(sale_price, sale_date, deed_amount, deed_date):
    """|deed - price|/price <= 3%; or no-price + deed date within 60 days."""
    amt = float(deed_amount or 0)
    if sale_price is not None and float(sale_price) > 0:
        return amt > 0 and abs(amt - float(sale_price)) / float(sale_price) <= AMOUNT_TOL
    if not deed_date or not sale_date:
        return False
    try:
        dd = datetime.date.fromisoformat(str(deed_date)[:10])
        sd = datetime.date.fromisoformat(str(sale_date)[:10])
    except ValueError:
        return False  # unparseable date is missing evidence: gate out, don't crash
    return abs((sd - dd).days) <= NO_PRICE_DATE_WINDOW_DAYS


def get_or_create_entity(conn, display_name):
    nn = norm_entity(display_name)
    if not nn:
        return None
    with conn.cursor() as cur:
        cur.execute(
            """INSERT INTO entities (display_name, norm_name, entity_type)
               VALUES (%s,%s,%s) ON CONFLICT (norm_name) DO UPDATE SET norm_name=EXCLUDED.norm_name
               RETURNING entity_id""",
            (str(display_name).strip(), nn, entity_type(nn)))
        return cur.fetchone()[0]


def apply_acris_party_fill(conn, deal_id, doc_id, deed_amount, deed_date,
                           buyer=None, seller=None, buyer_address=None, seller_address=None):
    """The ONLY path that attaches ACRIS parties. Enforces the amount gate in code;
    the DB CHECK (acris_requires_gate) makes bypassing this path impossible.
    Fill-only: existing party rows are untouched (ON CONFLICT DO NOTHING);
    the deal's sale_price is filled only when NULL."""
    with conn.cursor() as cur:
        cur.execute("SELECT sale_price, sale_date, notes FROM deals WHERE deal_id=%s", (deal_id,))
        drow = cur.fetchone()
        if not drow:
            return {"status": "no_such_deal"}
        sale_price, sale_date, notes = drow
        if not amount_gate(sale_price, sale_date, deed_amount, deed_date):
            return {"status": "gated_out"}
        filled = []
        for role, name, addr in (("buyer", buyer, buyer_address), ("seller", seller, seller_address)):
            if not name or is_placeholder(name):
                continue
            eid = get_or_create_entity(conn, name)
            if not eid:
                continue
            # A DIFFERENT entity already holding this role is a conflict:
            # invariant 3 says flag it, never auto-resolve (a correction deed or
            # a second matched deed must not quietly add a second buyer).
            cur.execute(
                """SELECT entity_id FROM deal_parties
                   WHERE deal_id=%s AND role=%s AND entity_id <> %s LIMIT 1""",
                (deal_id, role, eid))
            existing = cur.fetchone()
            if existing:
                flag_review(conn, "deal", deal_id, "party_conflict", {
                    "role": role, "existing_entity_id": str(existing[0]),
                    "incoming_name": str(name), "acris_doc_id": doc_id,
                    "deed_amount": float(deed_amount or 0)})
                continue
            cur.execute(
                """INSERT INTO deal_parties (deal_id, entity_id, role, mailing_address, source_system,
                                             provenance_ref, amount_gate_passed, verified_deed_amount)
                   VALUES (%s,%s,%s,%s,'acris',%s,TRUE,%s) ON CONFLICT DO NOTHING""",
                (deal_id, eid, role, addr, doc_id, deed_amount))
            if cur.rowcount:
                filled.append(role)
        if sale_price is None and float(deed_amount or 0) > 0:
            cur.execute("UPDATE deals SET sale_price=%s, updated_at=now() WHERE deal_id=%s AND sale_price IS NULL",
                        (float(deed_amount), deal_id))
            if cur.rowcount:
                filled.append("sale_price")
        if filled:
            note = f" | parties from ACRIS {doc_id} (amount-gated)"
            cur.execute(
                """UPDATE deals SET notes = trim(both ' |' from coalesce(notes,'') || %s), updated_at=now()
                   WHERE deal_id=%s AND (notes IS NULL OR position(%s in notes) = 0)""",
                (note, deal_id, note.strip(" |")))
    return {"status": "filled" if filled else "nothing_to_fill", "filled": filled}


# ── rolling ledger (rolling_done.pkl -> table) ───────────────────────────────
def rolling_not_done(conn, deal_ids):
    """Subtract the rolling ledger so a deal is processed at most once."""
    if not deal_ids:
        return []
    with conn.cursor() as cur:
        cur.execute("SELECT deal_id FROM rolling_ledger WHERE deal_id = ANY(%s::uuid[])",
                    ([str(d) for d in deal_ids],))
        done = {str(r[0]) for r in cur.fetchall()}
    return [d for d in deal_ids if str(d) not in done]


def mark_rolling_done(conn, deal_id):
    with conn.cursor() as cur:
        cur.execute("INSERT INTO rolling_ledger (deal_id) VALUES (%s) ON CONFLICT DO NOTHING", (deal_id,))


def unmark_rolling(conn, deal_id):
    """Release a ledger slot after a transient fetch error so the deal retries."""
    with conn.cursor() as cur:
        cur.execute("DELETE FROM rolling_ledger WHERE deal_id=%s", (deal_id,))


# ── review flag (conflicts get queued, never silently resolved) ──────────────
def flag_review(conn, object_type, object_id, issue_class, payload):
    with conn.cursor() as cur:
        cur.execute(
            """INSERT INTO review_queue (object_type, object_id, issue_class, payload)
               VALUES (%s,%s,%s,%s)""",
            (object_type, str(object_id), issue_class, json.dumps(payload)))


# ── run audit ────────────────────────────────────────────────────────────────
def start_run(conn, job):
    with conn.cursor() as cur:
        cur.execute("INSERT INTO scrape_runs (job, status) VALUES (%s,'running') RETURNING run_id", (job,))
        return cur.fetchone()[0]


def finish_run(conn, run_id, status, stats=None, error=None):
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE scrape_runs SET finished_at=now(), status=%s, stats=%s, error=%s WHERE run_id=%s",
            (status, json.dumps(stats or {}), error, run_id))
