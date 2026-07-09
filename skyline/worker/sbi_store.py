"""worker/sbi_store.py — production storage layer for the sbi_* schema.

This is the one Python write path used by the scraper worker. It preserves the
original pipeline invariants while writing to the live Supabase/Netlify RPC schema:

* durable fetch ledger: sbi_fetch_ledger
* durable exclusion ledger: sbi_exclusion_ledger
* gated merge path: sbi_properties + sbi_deals + sbi_review_queue
* amount-gated ACRIS party fills: sbi_deal_parties
* rolling-sales ledger: sbi_fetch_ledger(source='rolling')
* run audit: sbi_source_runs
"""
from __future__ import annotations

import datetime
import json
import os
import sys
from typing import Any, Dict, Iterable, Optional

import psycopg2

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
from shared.normalize import (
    BANNED_ASSET_TYPES,
    CONDO_BUILDING_CLASSES,
    ONE_TWO_FAMILY_CLASSES,
    entity_type,
    is_placeholder,
    norm_entity,
    normalize_address,
    split_address,
)

AMOUNT_TOL = 0.03
NO_PRICE_DATE_WINDOW_DAYS = 60


class MergeResult:
    def __init__(self, status: str, deal_id: Any = None, reason: Optional[str] = None):
        self.status = status
        self.deal_id = deal_id
        self.reason = reason


def connect():
    return psycopg2.connect(os.environ["DATABASE_URL"])


# ── run audit ────────────────────────────────────────────────────────────────
def start_run(conn, job: str, source: str = "python-worker"):
    with conn.cursor() as cur:
        cur.execute(
            """insert into sbi_source_runs (source, job, status, stats)
               values (%s, %s, 'running', '{}'::jsonb)
               returning run_id""",
            (source, job),
        )
        return cur.fetchone()[0]


def finish_run(conn, run_id, status: str, stats: Optional[Dict[str, Any]] = None, error: Optional[str] = None):
    mapped = {
        "success": "completed",
        "completed": "completed",
        "failed": "failed",
        "timeout": "timeout",
        "partial_success": "partial_success",
        "completed_with_errors": "completed_with_errors",
        "quota_blocked": "quota_blocked",
        "cancelled": "cancelled",
    }.get(status, "completed_with_errors")
    with conn.cursor() as cur:
        cur.execute(
            """update sbi_source_runs
               set finished_at=now(), status=%s, stats=%s::jsonb, error=%s
               where run_id=%s""",
            (mapped, json.dumps(stats or {}), error, run_id),
        )


# ── fetch ledger ─────────────────────────────────────────────────────────────
def urls_not_fetched(conn, urls: Iterable[str]):
    urls = list(urls or [])
    if not urls:
        return []
    with conn.cursor() as cur:
        cur.execute(
            """select source_key from sbi_fetch_ledger
               where source='url'
                 and source_key = any(%s)
                 and disposition not like 'fetch_error:%%'""",
            (urls,),
        )
        done = {r[0] for r in cur.fetchall()}
    return [u for u in urls if u not in done]


def record_fetch(conn, url: str, disposition: str):
    with conn.cursor() as cur:
        cur.execute(
            """insert into sbi_fetch_ledger (source, source_key, disposition)
               values ('url', %s, %s)
               on conflict (source, source_key)
               do update set disposition=excluded.disposition, fetched_at=now()""",
            (url, disposition),
        )


# ── exclusion ledger ─────────────────────────────────────────────────────────
def is_excluded(conn, address: str, price: Any):
    with conn.cursor() as cur:
        cur.execute(
            """select reason from sbi_exclusion_ledger
               where addr_norm=%s and price is not distinct from %s
               limit 1""",
            (normalize_address(address), int(float(price)) if price else 0),
        )
        row = cur.fetchone()
    return row[0] if row else None


def add_exclusion(conn, address: str, price: Any, reason: str, evidence: str):
    with conn.cursor() as cur:
        cur.execute(
            """insert into sbi_exclusion_ledger (addr_norm, price, reason, evidence, source)
               values (%s, %s, %s, %s, 'python-worker')
               on conflict do nothing""",
            (normalize_address(address), int(float(price)) if price else 0, reason, evidence),
        )


# ── canonical object helpers ─────────────────────────────────────────────────
def _property_id(cur, row: Dict[str, Any]):
    key = normalize_address(row["address"])
    borough = row.get("borough")
    cur.execute(
        """select property_id from sbi_properties
           where address_norm=%s and borough is not distinct from %s
           order by updated_at desc nulls last
           limit 1""",
        (key, borough),
    )
    got = cur.fetchone()
    number, street = split_address(row["address"])
    if got:
        if row.get("bldg_class"):
            cur.execute(
                """update sbi_properties
                   set building_class=coalesce(building_class,%s), updated_at=now()
                   where property_id=%s""",
                (row.get("bldg_class"), got[0]),
            )
        return got[0]
    cur.execute(
        """insert into sbi_properties
              (address_raw, street_number, street_name_canon, borough, market, building_class, source)
           values (%s, %s, %s, %s, %s, %s, %s)
           returning property_id""",
        (
            row["address"],
            number,
            street,
            borough,
            row.get("market"),
            row.get("bldg_class"),
            row.get("source_system") or "python-worker",
        ),
    )
    return cur.fetchone()[0]


def get_or_create_entity(conn, display_name: str):
    nn = norm_entity(display_name)
    if not nn:
        return None
    with conn.cursor() as cur:
        cur.execute(
            """insert into sbi_entities (display_name, entity_type, provenance)
               values (%s, %s, %s::jsonb)
               on conflict (norm_name) do update set updated_at=now()
               returning entity_id""",
            (str(display_name).strip(), entity_type(nn), json.dumps({"source": "python-worker"})),
        )
        return cur.fetchone()[0]


# ── merge ───────────────────────────────────────────────────────────────────
def merge_deal(conn, row: Dict[str, Any]):
    """Merge a scraper candidate into the live sbi_* schema.

    Expected row keys: address, borough, market, sale_date, post_date, asset_type,
    sale_price, units, sqft, source_system, source_url, shortcode, acris_doc_id,
    confidence, parse_status, notes, bldg_class.
    """
    address = row["address"]
    price = row.get("sale_price")

    reason = is_excluded(conn, address, price)
    if reason:
        return MergeResult("rejected_excluded", reason=reason)

    if row.get("asset_type") in BANNED_ASSET_TYPES:
        return MergeResult("rejected_banned_type", reason=row.get("asset_type"))

    cls = (row.get("bldg_class") or "").strip().upper()
    if cls and ONE_TWO_FAMILY_CLASSES.match(cls):
        add_exclusion(conn, address, price, "one_two_family", f"DOF class {cls} at merge time")
        return MergeResult("rejected_one_two_family", reason=cls)
    if cls and CONDO_BUILDING_CLASSES.match(cls):
        add_exclusion(conn, address, price, "condo", f"DOF class {cls} at merge time")
        return MergeResult("rejected_condo_class", reason=cls)

    parse_status = row.get("parse_status") or "ok"
    notes = row.get("notes") or ""
    if (
        not cls
        and row.get("source_system") in ("traded", "crexi", "instagram", "upload")
        and row.get("units") is not None
        and row["units"] <= 2
        and (row.get("asset_type") or "") in ("Multifamily", "", None)
    ):
        parse_status = "needs_review"
        notes = (notes + " | units<=2 without building-class evidence: possible 1-2 family — review").strip(" |")

    with conn.cursor() as cur:
        if row.get("acris_doc_id"):
            cur.execute("select 1 from sbi_deals where acris_doc_id=%s", (row["acris_doc_id"],))
            if cur.fetchone():
                return MergeResult("duplicate", reason="acris_doc_id")
        if row.get("shortcode"):
            cur.execute("select 1 from sbi_deals where shortcode=%s", (row["shortcode"],))
            if cur.fetchone():
                return MergeResult("duplicate", reason="shortcode")

        property_id = _property_id(cur, row)
        cur.execute(
            """select 1 from sbi_deals
               where property_id=%s
                 and sale_price is not distinct from %s
                 and sale_date is not distinct from %s""",
            (property_id, price, row.get("sale_date")),
        )
        if cur.fetchone():
            return MergeResult("duplicate", reason="addr_price_date")

        cur.execute(
            """insert into sbi_deals
                 (property_id, sale_date, post_date, asset_type, sale_price, units, sqft,
                  source_system, source_url, shortcode, acris_doc_id, confidence,
                  parse_status, notes, source_key, provenance)
               values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb)
               returning deal_id""",
            (
                property_id,
                row.get("sale_date"),
                row.get("post_date"),
                row.get("asset_type"),
                price,
                row.get("units"),
                row.get("sqft"),
                row["source_system"],
                row.get("source_url"),
                row.get("shortcode"),
                row.get("acris_doc_id"),
                row.get("confidence"),
                parse_status,
                notes or None,
                row.get("shortcode") or row.get("acris_doc_id") or row.get("source_url"),
                json.dumps({"source": "python-worker", "source_system": row.get("source_system")}),
            ),
        )
        deal_id = cur.fetchone()[0]
        if parse_status == "needs_review":
            cur.execute(
                """insert into sbi_review_queue (object_type, object_id, issue_class, payload)
                   values ('deal', %s, 'merge_flag', %s::jsonb)""",
                (str(deal_id), json.dumps({"address": address, "notes": notes[:400]})),
            )
    return MergeResult("merged", deal_id=deal_id)


# ── amount-gated ACRIS party fill ────────────────────────────────────────────
def amount_gate(sale_price: Any, sale_date: Any, deed_amount: Any, deed_date: Any) -> bool:
    amt = float(deed_amount or 0)
    if sale_price is not None and float(sale_price) > 0:
        return amt > 0 and abs(amt - float(sale_price)) / float(sale_price) <= AMOUNT_TOL
    if not deed_date or not sale_date:
        return False
    try:
        dd = datetime.date.fromisoformat(str(deed_date)[:10])
        sd = datetime.date.fromisoformat(str(sale_date)[:10])
    except ValueError:
        return False
    return abs((sd - dd).days) <= NO_PRICE_DATE_WINDOW_DAYS


def apply_acris_party_fill(
    conn,
    deal_id,
    doc_id,
    deed_amount,
    deed_date,
    buyer: Optional[str] = None,
    seller: Optional[str] = None,
    buyer_address: Optional[str] = None,
    seller_address: Optional[str] = None,
):
    with conn.cursor() as cur:
        cur.execute("select sale_price, sale_date, notes from sbi_deals where deal_id=%s", (deal_id,))
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
            cur.execute(
                """select entity_id from sbi_deal_parties
                   where deal_id=%s and role=%s and entity_id <> %s
                   limit 1""",
                (deal_id, role, eid),
            )
            existing = cur.fetchone()
            if existing:
                flag_review(
                    conn,
                    "deal",
                    deal_id,
                    "party_conflict",
                    {
                        "role": role,
                        "existing_entity_id": str(existing[0]),
                        "incoming_name": str(name),
                        "acris_doc_id": doc_id,
                        "deed_amount": float(deed_amount or 0),
                    },
                )
                continue
            cur.execute(
                """insert into sbi_deal_parties
                     (deal_id, entity_id, role, mailing_address, source_system,
                      provenance_ref, amount_gate_passed, verified_deed_amount, match_confidence)
                   values (%s, %s, %s, %s, 'acris', %s, true, %s, 100)
                   on conflict do nothing""",
                (deal_id, eid, role, addr, doc_id, deed_amount),
            )
            if cur.rowcount:
                filled.append(role)

        if sale_price is None and float(deed_amount or 0) > 0:
            cur.execute(
                "update sbi_deals set sale_price=%s, updated_at=now() where deal_id=%s and sale_price is null",
                (float(deed_amount), deal_id),
            )
            if cur.rowcount:
                filled.append("sale_price")

        if filled:
            note = f" | parties from ACRIS {doc_id} (amount-gated)"
            cur.execute(
                """update sbi_deals
                   set notes = trim(both ' |' from coalesce(notes,'') || %s), updated_at=now()
                   where deal_id=%s and (notes is null or position(%s in notes) = 0)""",
                (note, deal_id, note.strip(" |")),
            )
    return {"status": "filled" if filled else "nothing_to_fill", "filled": filled}


# ── rolling ledger via sbi_fetch_ledger ──────────────────────────────────────
def rolling_not_done(conn, deal_ids: Iterable[Any]):
    original = list(deal_ids or [])
    keys = [str(d) for d in original]
    if not keys:
        return []
    with conn.cursor() as cur:
        cur.execute(
            "select source_key from sbi_fetch_ledger where source='rolling' and source_key = any(%s)",
            (keys,),
        )
        done = {str(r[0]) for r in cur.fetchall()}
    return [d for d in original if str(d) not in done]


def mark_rolling_done(conn, deal_id):
    with conn.cursor() as cur:
        cur.execute(
            """insert into sbi_fetch_ledger (source, source_key, disposition)
               values ('rolling', %s, 'processed')
               on conflict (source, source_key)
               do update set disposition='processed', fetched_at=now()""",
            (str(deal_id),),
        )


def unmark_rolling(conn, deal_id):
    with conn.cursor() as cur:
        cur.execute("delete from sbi_fetch_ledger where source='rolling' and source_key=%s", (str(deal_id),))


# ── review queue ─────────────────────────────────────────────────────────────
def flag_review(conn, object_type: str, object_id: Any, issue_class: str, payload: Dict[str, Any]):
    with conn.cursor() as cur:
        cur.execute(
            """insert into sbi_review_queue (object_type, object_id, issue_class, payload)
               values (%s, %s, %s, %s::jsonb)""",
            (object_type, str(object_id), issue_class, json.dumps(payload or {})),
        )
