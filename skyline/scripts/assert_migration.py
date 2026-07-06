"""assert_migration.py — the migration is not done until these pass.
Usage: python3 scripts/assert_migration.py <dataset_v8.csv>
"""
import os, sys
import pandas as pd
import psycopg2

DB = os.environ.get("DATABASE_URL", "postgresql://skyline:skyline_dev@localhost/skyline")

def main(csv_path):
    df = pd.read_csv(csv_path, low_memory=False)
    conn = psycopg2.connect(DB); cur = conn.cursor()
    q = lambda sql: (cur.execute(sql), cur.fetchone()[0])[1]

    checks = []
    def check(name, got, want):
        ok = got == want
        checks.append(ok)
        print(f"{'PASS' if ok else 'FAIL'} - {name}: got {got}, want {want}")

    check("deal count", q("SELECT count(*) FROM deals"), len(df))
    check("deals with a buyer party",
          q("SELECT count(DISTINCT deal_id) FROM deal_parties WHERE role='buyer'"),
          int(df["Buyer"].notna().sum()))
    check("deals with a seller party",
          q("SELECT count(DISTINCT deal_id) FROM deal_parties WHERE role='seller'"),
          int(df["Seller"].notna().sum()))
    check("deals with price",
          q("SELECT count(*) FROM deals WHERE sale_price IS NOT NULL"),
          int(df["Sale Price"].notna().sum()))
    check("needs_review deals",
          q("SELECT count(*) FROM deals WHERE parse_status='needs_review'"),
          int((df["Parse Status"] == "needs_review").sum()))
    check("banned asset types present", q(
        "SELECT count(*) FROM deals WHERE asset_type IN "
        "('Condo','Commercial Condo','Co-op','Single Family','Two Family')"), 0)
    check("acris party rows without gate", q(
        "SELECT count(*) FROM deal_parties WHERE source_system='acris' AND amount_gate_passed IS NOT TRUE"), 0)
    check("exclusion ledger seeded", q("SELECT count(*) FROM exclusion_ledger"), 30)
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
