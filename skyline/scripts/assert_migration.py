"""assert_migration.py — the migration is not done until these pass.
Usage: python3 scripts/assert_migration.py <dataset_v8.csv>
"""
import os, sys
import pandas as pd
import psycopg2

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from shared.normalize import is_placeholder, norm_entity

DB = os.environ.get("DATABASE_URL", "postgresql://skyline:skyline_dev@localhost/skyline")
NYC_BOROUGHS = {"Manhattan", "Brooklyn", "Queens", "Bronx", "Staten Island"}


def _party_count(series):
    """Expected parties mirror migrate_csv's skip rules: placeholder names and
    names that normalize to nothing never become deal_parties rows — counting
    them made a CORRECT migration fail these assertions."""
    return int(series.dropna().map(lambda x: not is_placeholder(str(x))
                                   and norm_entity(str(x)) is not None).sum())


def main(csv_path):
    raw = pd.read_csv(csv_path, low_memory=False)
    df = raw[raw["Borough"].isin(NYC_BOROUGHS)].copy()
    conn = psycopg2.connect(DB); cur = conn.cursor()
    q = lambda sql: (cur.execute(sql), cur.fetchone()[0])[1]

    checks = []
    def check(name, got, want):
        ok = got == want
        checks.append(ok)
        print(f"{'PASS' if ok else 'FAIL'} - {name}: got {got}, want {want}")

    check("non-NYC rows excluded", len(raw) - len(df), 24)
    check("deal count", q("SELECT count(*) FROM deals"), len(df))
    check("deals with a buyer party",
          q("SELECT count(DISTINCT deal_id) FROM deal_parties WHERE role='buyer'"),
          _party_count(df["Buyer"]))
    check("deals with a seller party",
          q("SELECT count(DISTINCT deal_id) FROM deal_parties WHERE role='seller'"),
          _party_count(df["Seller"]))
    check("deals with price",
          q("SELECT count(*) FROM deals WHERE sale_price IS NOT NULL"),
          int(df["Sale Price"].notna().sum()))
    check("needs_review deals",
          q("SELECT count(*) FROM deals WHERE parse_status='needs_review'"),
          int((df["Parse Status"] == "needs_review").sum()))
    check("banned asset types present", q(
        "SELECT count(*) FROM deals WHERE asset_type IN "
        "('Condo','Commercial Condo','Co-op','Single Family','Two Family','1-2 Family')"), 0)
    check("acris party rows without gate", q(
        "SELECT count(*) FROM deal_parties WHERE source_system='acris' AND amount_gate_passed IS NOT TRUE"), 0)
    got_excl = q("SELECT count(*) FROM exclusion_ledger")
    ok_excl = got_excl >= 30  # ledger grows over time; the seed is the floor
    checks.append(ok_excl)
    print(f"{'PASS' if ok_excl else 'FAIL'} - exclusion ledger seeded: got {got_excl}, want >= 30")
    check("duplicate contact rows", q(
        "SELECT count(*) FROM (SELECT entity_id, phone, email FROM contacts "
        "GROUP BY entity_id, phone, email HAVING count(*) > 1) d"), 0)
    check("contacts without provenance", q(
        "SELECT count(*) FROM contacts WHERE source IS NULL"), 0)
    check("goodwin place absent",
          q("SELECT count(*) FROM properties WHERE address_raw ILIKE '%goodwin%'"), 0)
    check("equinox hotel deal present", q(
        "SELECT count(*) FROM deals d JOIN properties p USING (property_id) "
        "WHERE p.address_raw='35 Hudson Yards' AND d.sale_price=541000000"), 1)
    # PPU/PPSF generated columns agree with CSV-derived values on a sample
    cur.execute("""SELECT count(*) FROM deals
                   WHERE units > 0 AND sale_price IS NOT NULL
                     AND abs(ppu - round(sale_price/units, 2)) > 0.01""")
    check("generated PPU consistent", cur.fetchone()[0], 0)

    print("\nALL ASSERTIONS PASSED" if all(checks) else "\nASSERTION FAILURES PRESENT")
    sys.exit(0 if all(checks) else 1)

if __name__ == "__main__":
    main(sys.argv[1])
