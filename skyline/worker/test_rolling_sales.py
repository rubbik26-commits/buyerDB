"""rolling_sales port proof: missing sqft/units filled from Rolling Sales (agreement-gated),
generated PPU/PPSF recompute automatically, a >20% conflict is flagged not overwritten,
and the rolling ledger prevents reprocessing. Injected fetcher; scoped to test deals only.
Run: pytest worker/test_rolling_sales.py -v"""
import os, sys, uuid
import psycopg2, pytest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
os.environ.setdefault("DATABASE_URL", "postgresql://skyline:skyline_dev@localhost/skyline")
from worker import rolling_sales, store


def _mk(cur, tag, sqft, units, price):
    cur.execute("""INSERT INTO properties (address_raw, address_norm, borough)
                   VALUES (%s,%s,'Brooklyn') RETURNING property_id""",
                (f"500 {tag} Street Brooklyn NY", f"500 {tag.lower()} st"))
    pid = cur.fetchone()[0]
    cur.execute("""INSERT INTO deals (property_id, sale_date, asset_type, sale_price, sqft, units,
                                      source_system, shortcode, confidence, parse_status)
                   VALUES (%s,'2026-06-10','Multifamily',%s,%s,%s,'traded',%s,70,'ok') RETURNING deal_id""",
                (pid, price, sqft, units, f"TRADED-{tag}"))
    return cur.fetchone()[0]


@pytest.fixture()
def tag():
    t = "rs" + uuid.uuid4().hex[:8]
    yield t
    conn = psycopg2.connect(os.environ["DATABASE_URL"]); cur = conn.cursor()
    cur.execute("""DELETE FROM review_queue WHERE object_id IN
                   (SELECT d.deal_id::text FROM deals d JOIN properties p USING(property_id)
                    WHERE p.address_raw ILIKE %s)""", (f"%{t}%",))
    cur.execute("""DELETE FROM rolling_ledger WHERE deal_id IN
                   (SELECT d.deal_id FROM deals d JOIN properties p USING(property_id)
                    WHERE p.address_raw ILIKE %s)""", (f"%{t}%",))
    cur.execute("""DELETE FROM deals WHERE property_id IN
                   (SELECT property_id FROM properties WHERE address_raw ILIKE %s)""", (f"%{t}%",))
    cur.execute("DELETE FROM properties WHERE address_raw ILIKE %s", (f"%{t}%",))
    cur.execute("DELETE FROM scrape_runs WHERE job='rolling-sales'")
    conn.commit(); conn.close()


def test_rolling_fills_and_flags(tag):
    conn = store.connect()
    with conn.cursor() as cur:
        d_fill = _mk(cur, tag + "fill", None, None, 10_000_000)   # both missing -> fill
        d_conf = _mk(cur, tag + "conf", 5000, None, 5_000_000)     # sqft present, will conflict >20%
    conn.commit()

    # Rolling Sales returns consistent building attributes; canon street matches the deal street.
    def fetch(num, tok, boro_code):
        base = tok  # tok is the longest street token, e.g. 'RS....FILL'
        if "FILL" in base.upper():
            return [{"address": f"500 {tag}fill Street", "gross_square_feet": "20000",
                     "total_units": "10", "building_class_at_time_of": "D4"}]
        if "CONF" in base.upper():
            return [{"address": f"500 {tag}conf Street", "gross_square_feet": "20000",
                     "total_units": "8", "building_class_at_time_of": "C1"}]
        return []

    s = rolling_sales.run(conn=conn, fetch_fn=fetch, sleep=False,
                          only_deal_ids=[d_fill, d_conf])
    assert s["sqft_filled"] == 1, s          # only the fully-missing deal gets sqft
    assert s["units_filled"] == 2, s         # both had NULL units
    assert s["conflict_flagged"] == 1, s     # the 5000-vs-20000 disagreement

    with conn.cursor() as cur:
        # filled deal: sqft+units set; generated PPSF/PPU recomputed automatically
        cur.execute("SELECT sqft, units, ppsf, ppu FROM deals WHERE deal_id=%s", (d_fill,))
        sqft, units, ppsf, ppu = cur.fetchone()
        assert sqft == 20000 and units == 10, (sqft, units)
        assert float(ppsf) == 500.0 and float(ppu) == 1_000_000.0, (ppsf, ppu)  # 10M/20000, 10M/10

        # conflict deal: existing sqft NOT overwritten, flagged, review row exists
        cur.execute("SELECT sqft, units, parse_status FROM deals WHERE deal_id=%s", (d_conf,))
        csqft, cunits, cstatus = cur.fetchone()
        assert csqft == 5000 and cstatus == "needs_review", (csqft, cstatus)
        assert cunits == 8, cunits            # units was NULL -> filled
        cur.execute("SELECT count(*) FROM review_queue WHERE object_id=%s AND issue_class='sqft_conflict'",
                    (str(d_conf),))
        assert cur.fetchone()[0] == 1

    # re-run: both deals now in the rolling ledger -> not reprocessed
    s2 = rolling_sales.run(conn=conn, fetch_fn=fetch, sleep=False, only_deal_ids=[d_fill, d_conf])
    assert s2["targets"] == 0, s2
    conn.close()
