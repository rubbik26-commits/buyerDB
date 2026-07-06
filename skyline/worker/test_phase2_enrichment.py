"""phase2 + apply_enrichment port proof: an existing non-ACRIS deal missing parties
gets its buyer/seller filled from a matched ACRIS deed THROUGH THE AMOUNT GATE, and a
wrong-amount deed is gated out. Injected fetchers (no live Socrata).
Run: pytest worker/test_phase2_enrichment.py -v"""
import os, sys, uuid
import psycopg2, pytest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
os.environ.setdefault("DATABASE_URL", "postgresql://skyline:skyline_dev@localhost/skyline")
from worker import phase2_stages, store


def _insert_deal(cur, tag, price):
    cur.execute("""INSERT INTO properties (address_raw, address_norm, borough)
                   VALUES (%s,%s,'Brooklyn') RETURNING property_id""",
                (f"500 {tag} Street Brooklyn NY", f"500 {tag.lower()} st", ))
    pid = cur.fetchone()[0]
    cur.execute("""INSERT INTO deals (property_id, sale_date, asset_type, sale_price,
                                      source_system, source_url, shortcode, confidence, parse_status)
                   VALUES (%s,'2026-06-10','Multifamily',%s,'traded',%s,%s,70,'ok') RETURNING deal_id""",
                (pid, price, f"http://traded.co/{tag}", f"TRADED-{tag}"))
    return cur.fetchone()[0]


@pytest.fixture()
def tag():
    t = "e2" + uuid.uuid4().hex[:8]
    yield t
    conn = psycopg2.connect(os.environ["DATABASE_URL"]); cur = conn.cursor()
    cur.execute("""DELETE FROM deal_parties WHERE deal_id IN
                   (SELECT d.deal_id FROM deals d JOIN properties p USING(property_id)
                    WHERE p.address_raw ILIKE %s)""", (f"%{t}%",))
    cur.execute("""DELETE FROM deals WHERE property_id IN
                   (SELECT property_id FROM properties WHERE address_raw ILIKE %s)""", (f"%{t}%",))
    cur.execute("DELETE FROM properties WHERE address_raw ILIKE %s", (f"%{t}%",))
    cur.execute("DELETE FROM entities WHERE norm_name ILIKE %s", (f"%{t.upper()}%",))
    cur.execute("DELETE FROM scrape_runs WHERE job='phase2-enrichment'")
    conn.commit(); conn.close()


def test_phase2_fills_matched_party_through_gate(tag):
    price = 4_000_000
    doc = f"DEED{tag.upper()}"
    conn = store.connect()
    with conn.cursor() as cur:
        deal_id = _insert_deal(cur, tag, price)
    conn.commit()

    # inject: this address resolves to one candidate deed; the deed amount is within 3%
    lookup = lambda addr, boro: ({doc}, {"document_id": doc}) if tag in addr else None
    masters = lambda ids: {doc: {"document_id": doc, "document_amt": "3950000",  # within 3% of 4.0M
                                 "document_date": "2026-06-12", "doc_type": "DEED"}} if doc in ids else {}
    parties = lambda ids: {doc: {"buyer": f"{tag} BUYER LLC", "seller": f"{tag} SELLER LLC",
                                 "buyer_address": "10 Buyer Rd, Brooklyn NY",
                                 "seller_address": "20 Seller Rd, Brooklyn NY"}}

    s = phase2_stages.run(conn=conn, lookup_fn=lookup, masters_fn=masters, parties_fn=parties)
    assert s["matched"] >= 1 and s["filled"] >= 1, s

    # buyer + seller now attached, amount-gate-passed, sourced acris
    with conn.cursor() as cur:
        cur.execute("""SELECT dp.role, dp.source_system, dp.amount_gate_passed, e.display_name
                       FROM deal_parties dp JOIN entities e USING(entity_id)
                       WHERE dp.deal_id=%s ORDER BY dp.role""", (deal_id,))
        rows = cur.fetchall()
    roles = {r[0]: r for r in rows}
    assert "buyer" in roles and roles["buyer"][1] == "acris" and roles["buyer"][2] is True, rows
    assert tag.upper() in roles["buyer"][3].upper(), rows
    conn.close()


def test_phase2_wrong_amount_is_gated_out(tag):
    price = 4_000_000
    doc = f"DEED{tag.upper()}"
    conn = store.connect()
    with conn.cursor() as cur:
        deal_id = _insert_deal(cur, tag, price)
    conn.commit()

    lookup = lambda addr, boro: ({doc}, {"document_id": doc}) if tag in addr else None
    # deed amount 10M vs deal price 4M -> match_target's 3% filter rejects it -> no match
    masters = lambda ids: {doc: {"document_id": doc, "document_amt": "10000000",
                                 "document_date": "2026-06-12", "doc_type": "DEED"}}
    parties = lambda ids: {doc: {"buyer": f"{tag} WRONG LLC", "seller": None}}

    s = phase2_stages.run(conn=conn, lookup_fn=lookup, masters_fn=masters, parties_fn=parties)
    assert s["matched"] == 0 and s["filled"] == 0, s   # 3% amount filter blocked the wrong deed

    with conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM deal_parties WHERE deal_id=%s", (deal_id,))
        assert cur.fetchone()[0] == 0
    conn.close()
