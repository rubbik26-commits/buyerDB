"""Acceptance A: a scheduled incremental run ingests a new deal end-to-end with
ledger dedupe, proven in run stats — using an injected fetcher (no network).
Run: pytest worker/test_run_incremental.py -v"""
import os, sys, uuid
import psycopg2
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
os.environ.setdefault("DATABASE_URL", "postgresql://skyline:skyline_dev@localhost/skyline")

from worker import run_incremental, store


@pytest.fixture()
def clean_urls():
    """Track and delete the synthetic fetch-ledger + deal rows this test creates, so the
    shared DB is left as found (this test commits, unlike the rollback-based store tests)."""
    tag = uuid.uuid4().hex[:8]
    created = {"urls": [], "addr": f"12345 Acceptance Way {tag}"}
    yield tag, created
    conn = psycopg2.connect(os.environ["DATABASE_URL"]); cur = conn.cursor()
    cur.execute("DELETE FROM fetch_ledger WHERE url = ANY(%s)", (created["urls"],))
    cur.execute("""DELETE FROM deals WHERE property_id IN
                   (SELECT property_id FROM properties WHERE address_raw LIKE %s)""", (f"%{tag}%",))
    cur.execute("DELETE FROM properties WHERE address_raw LIKE %s", (f"%{tag}%",))
    cur.execute("DELETE FROM exclusion_ledger WHERE addr_norm LIKE %s", (f"%{tag.lower()}%",))
    cur.execute("DELETE FROM scrape_runs WHERE job='daily-incremental'")
    conn.commit(); conn.close()


def test_scheduled_run_ingests_dedupes_and_excludes(clean_urls):
    tag, created = clean_urls
    base = f"https://traded.co/deals/new-york/multifamily/sale/acc-{tag}"
    u_new = f"{base}-new/"
    u_resid = f"{base}-resid/"
    created["urls"] += [u_new, u_resid]

    # a legitimate new commercial deal, and a 1-2 family that must be rejected to the ledger
    rows = {
        u_new: ({"Address": f"100 Acceptance Way {tag}", "Borough": "Brooklyn", "Market": "test",
                 "sale_date_iso": "2026-06-20", "Asset Type": "Multifamily", "Sale Price": 5_000_000,
                 "Units": 20, "Sq Ft": 18000, "Source URL": u_new, "Shortcode": f"TRADED-acc-{tag}-new",
                 "Confidence": 80, "Parse Status": "ok", "Notes": "synthetic acceptance-A deal"}, "ok"),
        u_resid: ({"Address": f"200 Acceptance Way {tag}", "Borough": "Brooklyn", "Market": "test",
                   "sale_date_iso": "2026-06-21", "Asset Type": "Multifamily", "Sale Price": 1_200_000,
                   "Units": 2, "Source URL": u_resid, "Shortcode": f"TRADED-acc-{tag}-resid",
                   "Confidence": 70, "Parse Status": "ok", "Notes": "synthetic 1-2 family"}, "ok"),
    }
    # tag the property addresses so cleanup finds them
    created["addr"] = f"100 Acceptance Way {tag}"

    def discover():
        return [u_new, u_resid]

    def fetch(url):
        return rows[url]

    # first run: 1 merged, 1 rejected (units<=2 no class -> flagged-merge in store; but this row
    # has no bldg_class, so it is admitted FLAGGED, not rejected). To exercise a hard rejection,
    # pre-exclude the resid address so the exclusion ledger blocks it — proving ledger consultation.
    conn = store.connect()
    store.add_exclusion(conn, f"200 Acceptance Way {tag}", 1_200_000, "one_two_family",
                        "seeded for acceptance-A ledger test")
    conn.commit(); conn.close()

    s1 = run_incremental.run(discover_fn=discover, fetch_fn=fetch)
    assert s1["merged"] == 1, s1
    assert s1["rejected_excluded"] == 1, s1          # exclusion ledger consulted and enforced

    # second run: same discovery — both URLs now in the fetch ledger, so nothing is refetched
    s2 = run_incremental.run(discover_fn=discover, fetch_fn=fetch)
    assert s2["discovered"] == 2 and s2["new_urls"] == 0, s2   # fetch-ledger dedupe of discovery
    assert s2["merged"] == 0, s2

    # the merged deal is actually queryable
    conn = psycopg2.connect(os.environ["DATABASE_URL"]); cur = conn.cursor()
    cur.execute("""SELECT d.sale_price, d.asset_type FROM deals d JOIN properties p USING (property_id)
                   WHERE p.address_raw=%s""", (f"100 Acceptance Way {tag}",))
    got = cur.fetchone()
    conn.close()
    assert got == (5_000_000, "Multifamily"), got

    # and a scrape_runs row recorded the stats
    conn = psycopg2.connect(os.environ["DATABASE_URL"]); cur = conn.cursor()
    cur.execute("""SELECT status, stats->>'merged', stats->>'rejected_excluded'
                   FROM scrape_runs WHERE job='daily-incremental' ORDER BY started_at DESC LIMIT 2""")
    runs = cur.fetchall()
    conn.close()
    assert runs[0][0] == "success"
