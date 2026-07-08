import os, sys, json
import psycopg2

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
from shared.normalize import normalize_address, split_address, BANNED_ASSET_TYPES, ONE_TWO_FAMILY_CLASSES, CONDO_BUILDING_CLASSES

class MergeResult:
    def __init__(self, status, deal_id=None, reason=None):
        self.status = status
        self.deal_id = deal_id
        self.reason = reason


def connect():
    return psycopg2.connect(os.environ["DATABASE_URL"])


def start_run(conn, job):
    with conn.cursor() as cur:
        cur.execute("insert into sbi_source_runs (source, job, status) values ('worker', %s, 'running') returning run_id", (job,))
        return cur.fetchone()[0]


def finish_run(conn, run_id, status, stats=None, error=None):
    mapped = {"success": "completed", "completed": "completed", "failed": "failed", "timeout": "timeout"}.get(status, "completed_with_errors")
    with conn.cursor() as cur:
        cur.execute("update sbi_source_runs set finished_at=now(), status=%s, stats=%s, error=%s where run_id=%s", (mapped, json.dumps(stats or {}), error, run_id))


def urls_not_fetched(conn, urls):
    if not urls:
        return []
    with conn.cursor() as cur:
        cur.execute("select source_key from sbi_fetch_ledger where source='url' and source_key = any(%s)", (list(urls),))
        seen = {r[0] for r in cur.fetchall()}
    return [u for u in urls if u not in seen]


def record_fetch(conn, url, disposition):
    with conn.cursor() as cur:
        cur.execute("""
            insert into sbi_fetch_ledger (source, source_key, disposition)
            values ('url', %s, %s)
            on conflict (source, source_key)
            do update set disposition=excluded.disposition, fetched_at=now()
        """, (url, disposition))


def _excluded(conn, address, price):
    with conn.cursor() as cur:
        cur.execute("select reason from sbi_exclusion_ledger where addr_norm=%s and price is not distinct from %s", (normalize_address(address), int(price) if price else 0))
        row = cur.fetchone()
    return row[0] if row else None


def _add_exclusion(conn, address, price, reason, evidence):
    with conn.cursor() as cur:
        cur.execute("""
            insert into sbi_exclusion_ledger (addr_norm, price, reason, evidence, source)
            values (%s,%s,%s,%s,'worker') on conflict do nothing
        """, (normalize_address(address), int(price) if price else 0, reason, evidence))


def _property_id(cur, row):
    key = normalize_address(row["address"])
    borough = row.get("borough")
    cur.execute("select property_id from sbi_properties where address_norm=%s and borough is not distinct from %s order by updated_at desc nulls last limit 1", (key, borough))
    got = cur.fetchone()
    if got:
        return got[0]
    number, street = split_address(row["address"])
    cur.execute("""
        insert into sbi_properties (address_raw, street_number, street_name_canon, borough, market, source)
        values (%s,%s,%s,%s,%s,%s) returning property_id
    """, (row["address"], number, street, borough, row.get("market"), row.get("source_system") or "worker"))
    return cur.fetchone()[0]


def merge_deal(conn, row):
    address = row["address"]
    price = row.get("sale_price")
    reason = _excluded(conn, address, price)
    if reason:
        return MergeResult("rejected_excluded", reason=reason)
    if row.get("asset_type") in BANNED_ASSET_TYPES:
        return MergeResult("rejected_banned_type", reason=row.get("asset_type"))
    cls = (row.get("bldg_class") or "").strip().upper()
    if cls and ONE_TWO_FAMILY_CLASSES.match(cls):
        _add_exclusion(conn, address, price, "one_two_family", f"DOF class {cls}")
        return MergeResult("rejected_one_two_family", reason=cls)
    if cls and CONDO_BUILDING_CLASSES.match(cls):
        _add_exclusion(conn, address, price, "condo", f"DOF class {cls}")
        return MergeResult("rejected_condo_class", reason=cls)

    parse_status = row.get("parse_status") or "ok"
    notes = row.get("notes") or ""
    with conn.cursor() as cur:
        property_id = _property_id(cur, row)
        if row.get("acris_doc_id"):
            cur.execute("select 1 from sbi_deals where acris_doc_id=%s", (row["acris_doc_id"],))
            if cur.fetchone():
                return MergeResult("duplicate", reason="acris_doc_id")
        cur.execute("""
            select 1 from sbi_deals
            where property_id=%s and sale_price is not distinct from %s and sale_date is not distinct from %s
        """, (property_id, price, row.get("sale_date")))
        if cur.fetchone():
            return MergeResult("duplicate", reason="addr_price_date")
        cur.execute("""
            insert into sbi_deals (property_id, sale_date, post_date, asset_type, sale_price, units, sqft, source_system, source_url, shortcode, acris_doc_id, confidence, parse_status, notes, source_key)
            values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) returning deal_id
        """, (property_id, row.get("sale_date"), row.get("post_date"), row.get("asset_type"), price, row.get("units"), row.get("sqft"), row["source_system"], row.get("source_url"), row.get("shortcode"), row.get("acris_doc_id"), row.get("confidence"), parse_status, notes or None, row.get("shortcode") or row.get("acris_doc_id") or row.get("source_url")))
        deal_id = cur.fetchone()[0]
        if parse_status == "needs_review":
            cur.execute("insert into sbi_review_queue (object_type, object_id, issue_class, payload) values ('deal', %s, 'merge_flag', %s)", (str(deal_id), json.dumps({"address": address, "notes": notes[:400]})))
    return MergeResult("merged", deal_id=deal_id)
