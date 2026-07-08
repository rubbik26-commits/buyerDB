"""Admin/audit API for data quality and operational health.

This is the non-Base44 replacement for the useful Admin Audit workflow from
`dealflow-insights`: surface problems, do not hide failed imports/runs, and keep
cleanup actions explicit and auditable.
"""
from fastapi import APIRouter

from ..db import db, rows

router = APIRouter(prefix="/api/admin")


@router.get("/audit")
def audit():
    with db() as conn, conn.cursor() as cur:
        cur.execute("""
            SELECT
              (SELECT count(*) FROM properties) AS properties,
              (SELECT count(*) FROM deals) AS deals,
              (SELECT count(*) FROM entities) AS entities,
              (SELECT count(*) FROM contacts) AS contacts,
              (SELECT count(*) FROM uploads) AS uploads,
              (SELECT count(*) FROM review_queue WHERE status='open') AS open_reviews,
              (SELECT count(*) FROM scrape_runs WHERE status='running') AS running_scrapes,
              (SELECT count(*) FROM scrape_runs WHERE status IN ('failed','timeout','quota_blocked','completed_with_errors')) AS failed_scrapes
        """)
        totals = rows(cur)[0]

        cur.execute("""
            SELECT address_norm, borough, count(*) AS n
            FROM properties
            GROUP BY address_norm, borough
            HAVING count(*) > 1
            ORDER BY n DESC, address_norm
            LIMIT 25
        """)
        duplicate_properties = rows(cur)

        cur.execute("""
            SELECT p.address_raw AS address, p.borough, d.sale_price, d.sale_date, count(*) AS n
            FROM deals d
            JOIN properties p USING (property_id)
            GROUP BY p.address_raw, p.borough, d.sale_price, d.sale_date
            HAVING count(*) > 1
            ORDER BY n DESC, d.sale_date DESC NULLS LAST
            LIMIT 25
        """)
        duplicate_deals = rows(cur)

        cur.execute("""
            SELECT d.deal_id, p.address_raw AS address, p.borough, d.asset_type, d.sale_price, d.sale_date,
                   EXISTS (SELECT 1 FROM deal_parties dp WHERE dp.deal_id=d.deal_id AND dp.role='buyer') AS has_buyer,
                   EXISTS (SELECT 1 FROM deal_parties dp WHERE dp.deal_id=d.deal_id AND dp.role='seller') AS has_seller
            FROM deals d
            JOIN properties p USING (property_id)
            WHERE NOT EXISTS (SELECT 1 FROM deal_parties dp WHERE dp.deal_id=d.deal_id AND dp.role='buyer')
               OR NOT EXISTS (SELECT 1 FROM deal_parties dp WHERE dp.deal_id=d.deal_id AND dp.role='seller')
            ORDER BY d.sale_price DESC NULLS LAST, d.sale_date DESC NULLS LAST
            LIMIT 50
        """)
        missing_parties = rows(cur)

        cur.execute("""
            SELECT e.entity_id, e.display_name AS name, count(*) AS deal_count,
                   coalesce(sum(d.sale_price),0) AS volume, max(d.sale_date) AS last_deal
            FROM deal_parties dp
            JOIN entities e USING (entity_id)
            JOIN deals d USING (deal_id)
            LEFT JOIN contacts c ON c.entity_id=e.entity_id
            WHERE dp.role='buyer'
            GROUP BY e.entity_id, e.display_name
            HAVING count(*) >= 2 AND count(c.contact_id)=0
            ORDER BY volume DESC NULLS LAST, deal_count DESC
            LIMIT 50
        """)
        contact_gaps = rows(cur)

        cur.execute("""
            SELECT run_id, job, started_at, finished_at, status, stats, error
            FROM scrape_runs
            WHERE status IN ('running','failed','timeout','quota_blocked','completed_with_errors')
            ORDER BY started_at DESC
            LIMIT 50
        """)
        problem_runs = rows(cur)

        cur.execute("""
            SELECT upload_id, filename, row_count, status, created_at
            FROM uploads
            WHERE status IN ('failed','resolving','staged')
            ORDER BY created_at DESC
            LIMIT 50
        """)
        problem_uploads = rows(cur)

    return {
        "totals": totals,
        "duplicate_properties": duplicate_properties,
        "duplicate_deals": duplicate_deals,
        "missing_parties": missing_parties,
        "contact_gaps": contact_gaps,
        "problem_runs": problem_runs,
        "problem_uploads": problem_uploads,
    }


@router.post("/fix-stale-runs")
def fix_stale_runs():
    """Mark stale running scraper rows as timeout. Does not delete anything."""
    with db() as conn, conn.cursor() as cur:
        cur.execute("""
            UPDATE scrape_runs
            SET status='timeout', finished_at=now(),
                error=coalesce(error, 'Marked timeout by admin audit: running for more than one hour')
            WHERE status='running'
              AND started_at < now() - interval '1 hour'
            RETURNING run_id, job, started_at, finished_at, status
        """)
        fixed = rows(cur)
    return {"fixed": fixed, "count": len(fixed)}
