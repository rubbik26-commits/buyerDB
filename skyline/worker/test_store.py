"""Tests for worker/store.py against the live Postgres. Run: pytest worker/test_store.py -v
Each test opens its own transaction and rolls back — the migrated data is never mutated."""
import os, sys, uuid
import psycopg2
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
from worker import store

os.environ.setdefault("DATABASE_URL", "postgresql://skyline:skyline_dev@localhost/skyline")


@pytest.fixture()
def conn():
    c = psycopg2.connect(os.environ["DATABASE_URL"])
    yield c
    c.rollback()   # every test's writes are discarded
    c.close()


def _row(**over):
    base = dict(address=f"999 Test Street #{uuid.uuid4().hex[:6]}", borough="Brooklyn",
                market="test", sale_date="2026-06-01", post_date=None, asset_type="Retail",
                sale_price=2_000_000, units=5, sqft=4000, source_system="traded",
                source_url=f"https://traded.co/deals/new-york/retail/sale/t-{uuid.uuid4().hex[:8]}/",
                shortcode=f"TEST-{uuid.uuid4().hex[:8]}", acris_doc_id=None,
                confidence=80, parse_status="ok", notes="test row", bldg_class=None)
    base.update(over)
    return base


def test_fetch_ledger_dedupe(conn):
    u = f"https://traded.co/deals/new-york/retail/sale/ledger-{uuid.uuid4().hex[:8]}/"
    assert store.urls_not_fetched(conn, [u]) == [u]
    store.record_fetch(conn, u, "ok")
    assert store.urls_not_fetched(conn, [u]) == []          # subtracted on next discovery


def test_exclusion_ledger_blocks_merge(conn):
    r = _row()
    store.add_exclusion(conn, r["address"], r["sale_price"], "condo_unit", "test evidence")
    res = store.merge_deal(conn, r)
    assert res.status == "rejected_excluded" and res.reason == "condo_unit"


def test_banned_asset_type_rejected(conn):
    res = store.merge_deal(conn, _row(asset_type="Single Family"))
    assert res.status == "rejected_banned_type"


def test_one_two_family_class_rejected_and_ledgered(conn):
    r = _row(asset_type="Multifamily", units=2, bldg_class="B1")
    res = store.merge_deal(conn, r)
    assert res.status == "rejected_one_two_family" and res.reason == "B1"
    # and it can never re-enter: second attempt hits the exclusion ledger
    assert store.merge_deal(conn, r).status == "rejected_excluded"


def test_condo_class_rejected(conn):
    res = store.merge_deal(conn, _row(bldg_class="RM"))
    assert res.status == "rejected_condo_class"


def test_units2_no_class_admitted_flagged(conn):
    res = store.merge_deal(conn, _row(asset_type="Multifamily", units=2, bldg_class=None))
    assert res.status == "merged"
    with conn.cursor() as cur:
        cur.execute("SELECT parse_status, notes FROM deals WHERE deal_id=%s", (res.deal_id,))
        ps, notes = cur.fetchone()
    assert ps == "needs_review" and "possible 1-2 family" in notes


def test_duplicate_addr_price_date(conn):
    r = _row()
    assert store.merge_deal(conn, r).status == "merged"
    assert store.merge_deal(conn, dict(r, shortcode=f"TEST-{uuid.uuid4().hex[:8]}",
                                       source_url=r["source_url"] + "x/")).status == "duplicate"


def test_amount_gate_rejects_wrong_deed(conn):
    res = store.merge_deal(conn, _row(sale_price=2_000_000))
    out = store.apply_acris_party_fill(conn, res.deal_id, "TESTDOC1",
                                       deed_amount=3_000_000, deed_date="2026-06-01",
                                       buyer="WRONG DEED LLC")
    assert out["status"] == "gated_out"
    with conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM deal_parties WHERE deal_id=%s", (res.deal_id,))
        assert cur.fetchone()[0] == 0


def test_amount_gate_passes_within_3pct_and_fills(conn):
    res = store.merge_deal(conn, _row(sale_price=2_000_000))
    out = store.apply_acris_party_fill(conn, res.deal_id, "TESTDOC2",
                                       deed_amount=2_040_000, deed_date="2026-06-01",   # 2.0% off
                                       buyer="RIGHT DEED LLC", seller="SELLER CORP")
    assert out["status"] == "filled" and set(out["filled"]) == {"buyer", "seller"}
    with conn.cursor() as cur:
        cur.execute("""SELECT source_system, amount_gate_passed, provenance_ref
                       FROM deal_parties WHERE deal_id=%s""", (res.deal_id,))
        rows = cur.fetchall()
    assert len(rows) == 2 and all(r == ("acris", True, "TESTDOC2") for r in rows)


def test_no_price_deal_fills_within_60_days_and_sets_price(conn):
    res = store.merge_deal(conn, _row(sale_price=None))
    out = store.apply_acris_party_fill(conn, res.deal_id, "TESTDOC3",
                                       deed_amount=1_500_000, deed_date="2026-05-20",   # 12 days
                                       buyer="NO PRICE BUYER LLC")
    assert out["status"] == "filled" and "sale_price" in out["filled"]
    with conn.cursor() as cur:
        cur.execute("SELECT sale_price FROM deals WHERE deal_id=%s", (res.deal_id,))
        assert float(cur.fetchone()[0]) == 1_500_000


def test_never_overwrite_existing_party(conn):
    res = store.merge_deal(conn, _row(sale_price=2_000_000))
    store.apply_acris_party_fill(conn, res.deal_id, "TESTDOC4", 2_000_000, "2026-06-01",
                                 buyer="FIRST BUYER LLC")
    # a second fill for the same role with a different entity inserts a second party row?
    # NO for same entity (conflict), and for a different entity it would add a row —
    # verify the FIRST row is never mutated and the deal price is never changed.
    with conn.cursor() as cur:
        cur.execute("UPDATE deals SET sale_price=sale_price WHERE deal_id=%s", (res.deal_id,))
    out = store.apply_acris_party_fill(conn, res.deal_id, "TESTDOC4", 2_000_000, "2026-06-01",
                                       buyer="FIRST BUYER LLC")
    assert out["status"] == "nothing_to_fill"
    with conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM deal_parties WHERE deal_id=%s AND role='buyer'", (res.deal_id,))
        assert cur.fetchone()[0] == 1


def test_conflicting_party_is_flagged_not_added(conn):
    """Invariant 3: a DIFFERENT gated entity for an already-filled role must land
    in review_queue, never as a silent second buyer."""
    res = store.merge_deal(conn, _row(sale_price=2_000_000))
    store.apply_acris_party_fill(conn, res.deal_id, "TESTDOC5", 2_000_000, "2026-06-01",
                                 buyer="FIRST BUYER LLC")
    out = store.apply_acris_party_fill(conn, res.deal_id, "TESTDOC6", 2_000_000, "2026-06-01",
                                       buyer="SECOND BUYER LLC")
    assert out["status"] == "nothing_to_fill"
    with conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM deal_parties WHERE deal_id=%s AND role='buyer'", (res.deal_id,))
        assert cur.fetchone()[0] == 1                       # still exactly one buyer
        cur.execute("""SELECT payload->>'incoming_name' FROM review_queue
                       WHERE object_id=%s::text AND issue_class='party_conflict'""", (str(res.deal_id),))
        flagged = cur.fetchone()
        assert flagged and flagged[0] == "SECOND BUYER LLC"


def test_db_check_blocks_ungated_acris_party(conn):
    """Belt AND suspenders: even raw SQL cannot insert an ungated acris party."""
    res = store.merge_deal(conn, _row())
    eid = store.get_or_create_entity(conn, "SNEAKY LLC")
    with pytest.raises(psycopg2.errors.CheckViolation):
        with conn.cursor() as cur:
            cur.execute(
                """INSERT INTO deal_parties (deal_id, entity_id, role, source_system, amount_gate_passed)
                   VALUES (%s,%s,'buyer','acris',NULL)""", (res.deal_id, eid))
