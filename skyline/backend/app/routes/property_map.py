"""Property map API.

Returns only real geocoded rows. No mock coordinates are generated.
"""
from fastapi import APIRouter, Query
from ..db import db, rows

router = APIRouter(prefix="/api")


@router.get("/property-map")
def property_map(limit: int = Query(1000, ge=1, le=5000)):
    with db() as conn, conn.cursor() as cur:
        cur.execute("""
            WITH latest AS (
              SELECT DISTINCT ON (p.property_id)
                p.property_id,
                p.address_raw AS address,
                p.borough,
                p.market,
                p.bbl,
                p.latitude,
                p.longitude,
                d.deal_id,
                d.sale_date,
                d.asset_type,
                d.sale_price,
                b.entity_id AS buyer_entity_id,
                b.display_name AS buyer,
                s.display_name AS seller
              FROM properties p
              LEFT JOIN deals d ON d.property_id=p.property_id
              LEFT JOIN LATERAL (
                SELECT e.entity_id, e.display_name
                FROM deal_parties dp JOIN entities e USING(entity_id)
                WHERE dp.deal_id=d.deal_id AND dp.role='buyer'
                LIMIT 1
              ) b ON true
              LEFT JOIN LATERAL (
                SELECT e.display_name
                FROM deal_parties dp JOIN entities e USING(entity_id)
                WHERE dp.deal_id=d.deal_id AND dp.role='seller'
                LIMIT 1
              ) s ON true
              WHERE p.latitude IS NOT NULL AND p.longitude IS NOT NULL
              ORDER BY p.property_id, d.sale_date DESC NULLS LAST, d.created_at DESC NULLS LAST
            )
            SELECT * FROM latest
            ORDER BY sale_price DESC NULLS LAST
            LIMIT %s
        """, (limit,))
        points = rows(cur)
        cur.execute("SELECT count(*) FROM properties WHERE latitude IS NOT NULL AND longitude IS NOT NULL")
        count = cur.fetchone()[0]
    return {"points": points, "count": count}
