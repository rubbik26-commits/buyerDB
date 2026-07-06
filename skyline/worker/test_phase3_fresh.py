"""phase3_fresh port proof: fresh ACRIS deeds ingest end-to-end into Postgres with
amount-gated parties, residential classes rejected, and doc_id dedupe on re-run.
Injected fetchers (no live Socrata). Run: pytest worker/test_phase3_fresh.py -v"""
import os, sys, uuid
import psycopg2, pytest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
os.environ.setdefault("DATABASE_URL", "postgresql://skyline:skyline_dev@localhost/skyline")
from worker import phase3_fresh, store


@pytest.fixture()
def tag():
    t = "p3" + uuid.uuid4().hex[:8]
    yield t
    conn = psycopg2.connect(os.environ["DATABASE_URL"]); cur = conn.cursor()
    cur.execute("""DELETE FROM deal_parties WHERE deal_id IN
                   (SELECT d.deal_id FROM deals d JOIN properties p USING (property_id)
                    WHERE p.address_raw ILIKE %s)""", (f"%{t}%",))
    cur.execute("""DELETE FROM deals WHERE property_id IN
                   (SELECT property_id FROM properties WHERE address_raw ILIKE %s)""", (f"%{t}%",))
    cur.execute("DELETE FROM properties WHERE address_raw ILIKE %s", (f"%{t}%",))
    cur.execute("DELETE FROM entities WHERE norm_name ILIKE %s", (f"%{t.upper()}%",))
    cur.execute("DELETE FROM scrape_runs WHERE job='phase3-fresh'")
    conn.commit(); conn.close()


def test_phase3_ingests_gates_and_dedupes(tag):
    # doc A: a real $5M office deed with a commercial PLUTO class -> should ingest + parties
    # doc B: a $3M deed on a 1-family class 'A1' -> classify() returns None -> rejected_class
    docA, docB = f"DEEDA{tag.upper()}", f"DEEDB{tag.upper()}"
    masters = [
        {"document_id": docA, "document_amt": "5000000", "document_date": "2026-06-01T00:00:00.000",
         "recorded_datetime": "2026-06-03T00:00:00.000"},
        {"document_id": docB, "document_amt": "3000000", "document_date": "2026-06-02T00:00:00.000",
         "recorded_datetime": "2026-06-04T00:00:00.000"},
    ]
    legals = {
        docA: {"street_number": "100", "street_name": f"{tag} PLAZA", "borough": "1",
               "block": "00123", "lot": "0045", "property_type": "OF"},
        docB: {"street_number": "200", "street_name": f"{tag} LANE", "borough": "1",
               "block": "00124", "lot": "0046", "property_type": "A1"},
    }
    bblA = store.__dict__  # noqa (not used; bbl computed inside)
    from acris_enrich import build_bbl
    plutoA = build_bbl("1", "00123", "0045")
    plutoB = build_bbl("1", "00124", "0046")
    pluto = {
        str(int(plutoA)): {"bldgclass": "O4", "unitstotal": "0", "bldgarea": "40000"},
        str(int(plutoB)): {"bldgclass": "A1", "unitstotal": "1", "bldgarea": "2000"},
    }
    parties = {
        docA: {"buyer": f"{tag} OFFICE ACQUISITIONS LLC", "seller": f"{tag} SELLER CORP",
               "buyer_address": "1 Park Ave, New York NY", "seller_address": "2 Park Ave, New York NY"},
    }

    fm = lambda: masters
    fd = lambda ids: (parties, legals)
    fp = lambda lg: pluto

    s1 = phase3_fresh.run(fetch_masters_fn=fm, fetch_detail_fn=fd, fetch_pluto_fn=fp)
    assert s1["merged"] == 1, s1                     # docA merged, docB rejected by class
    assert s1["rejected_class"] == 1, s1
    assert s1["parties_filled"] == 1, s1

    # the deal exists with amount-gated ACRIS parties
    conn = psycopg2.connect(os.environ["DATABASE_URL"]); cur = conn.cursor()
    cur.execute("""SELECT d.deal_id, d.sale_price, d.asset_type, d.acris_doc_id
                   FROM deals d JOIN properties p USING (property_id)
                   WHERE p.address_raw ILIKE %s""", (f"%{tag}%",))
    deal = cur.fetchone()
    assert deal and float(deal[1]) == 5000000 and deal[2] == "Office", deal
    cur.execute("""SELECT role, source_system, amount_gate_passed, verified_deed_amount
                   FROM deal_parties WHERE deal_id=%s ORDER BY role""", (deal[0],))
    pr = cur.fetchall()
    conn.close()
    roles = {r[0]: r for r in pr}
    assert "buyer" in roles and roles["buyer"][1] == "acris" and roles["buyer"][2] is True, pr
    assert float(roles["buyer"][3]) == 5000000, pr   # gated on the deed amount

    # re-run: docA now deduped on acris_doc_id, nothing new merged
    s2 = phase3_fresh.run(fetch_masters_fn=fm, fetch_detail_fn=fd, fetch_pluto_fn=fp)
    assert s2["merged"] == 0 and s2["duplicate"] == 1, s2
