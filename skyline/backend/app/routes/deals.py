"""Deals / buyers / leaderboards — the artifact's shared filter system, server-side.
All filters are parameterized (no string interpolation of user input into SQL)."""
import uuid
from fastapi import APIRouter, Query
from typing import Optional
from ..db import db, rows

router = APIRouter(prefix="/api")

# ORDER BY inside the laterals: without it a multi-party deal shows a
# plan-dependent buyer/seller that can flap between calls.
BASE = """
FROM deals d
JOIN properties p USING (property_id)
LEFT JOIN LATERAL (
  SELECT e.display_name, e.entity_id FROM deal_parties dp JOIN entities e USING (entity_id)
  WHERE dp.deal_id = d.deal_id AND dp.role = 'buyer' ORDER BY dp.entity_id LIMIT 1) b ON true
LEFT JOIN LATERAL (
  SELECT e.display_name FROM deal_parties dp JOIN entities e USING (entity_id)
  WHERE dp.deal_id = d.deal_id AND dp.role = 'seller' ORDER BY dp.entity_id LIMIT 1) s ON true
"""

def _filters(q, borough, asset_type, market, price_min, price_max, date_min, date_max,
             units_min, units_max, sqft_min, sqft_max, ppsf_max, confidence_min,
             status, has_buyer):
    where, params = ["1=1"], []
    if q:
        where.append("(p.address_raw ILIKE %s OR b.display_name ILIKE %s OR s.display_name ILIKE %s)")
        params += [f"%{q}%"] * 3
    for col, val in (("p.borough", borough), ("d.asset_type", asset_type), ("p.market", market)):
        if val:
            where.append(f"{col} = %s"); params.append(val)
    for col, val, op in (("d.sale_price", price_min, ">="), ("d.sale_price", price_max, "<="),
                         ("d.sale_date", date_min, ">="), ("d.sale_date", date_max, "<="),
                         ("d.units", units_min, ">="), ("d.units", units_max, "<="),
                         ("d.sqft", sqft_min, ">="), ("d.sqft", sqft_max, "<="),
                         ("d.ppsf", ppsf_max, "<="), ("d.confidence", confidence_min, ">=")):
        if val is not None:
            where.append(f"{col} {op} %s"); params.append(val)
    if status:
        where.append("d.parse_status = %s"); params.append(status)
    if has_buyer:
        where.append("b.display_name IS NOT NULL")
    return " AND ".join(where), params

SORTABLE = {"sale_date": "d.sale_date", "sale_price": "d.sale_price", "units": "d.units",
            "sqft": "d.sqft", "ppsf": "d.ppsf", "ppu": "d.ppu", "confidence": "d.confidence",
            "address": "p.address_raw"}

@router.get("/deals")
def list_deals(q: Optional[str] = None, borough: Optional[str] = None,
               asset_type: Optional[str] = None, market: Optional[str] = None,
               price_min: Optional[float] = None, price_max: Optional[float] = None,
               date_min: Optional[str] = None, date_max: Optional[str] = None,
               units_min: Optional[int] = None, units_max: Optional[int] = None,
               sqft_min: Optional[int] = None, sqft_max: Optional[int] = None,
               ppsf_max: Optional[float] = None, confidence_min: Optional[int] = None,
               status: Optional[str] = None, has_buyer: bool = False,
               sort: str = "sale_date", order: str = "desc",
               page: int = Query(1, ge=1), per_page: int = Query(50, ge=1, le=200)):
    where, params = _filters(q, borough, asset_type, market, price_min, price_max,
                             date_min, date_max, units_min, units_max, sqft_min, sqft_max,
                             ppsf_max, confidence_min, status, has_buyer)
    sort_col = SORTABLE.get(sort, "d.sale_date")
    direction = "ASC" if order == "asc" else "DESC"
    with db() as conn, conn.cursor() as cur:
        cur.execute(f"SELECT count(*) {BASE} WHERE {where}", params)
        total = cur.fetchone()[0]
        cur.execute(f"""
            SELECT d.deal_id, d.sale_date, p.address_raw AS address, p.borough, p.market,
                   d.asset_type, b.display_name AS buyer, s.display_name AS seller,
                   d.sale_price, d.units, d.sqft, d.ppu, d.ppsf, d.confidence,
                   d.parse_status, d.source_url, d.source_system, d.notes
            {BASE} WHERE {where}
            ORDER BY {sort_col} {direction} NULLS LAST, d.deal_id
            LIMIT %s OFFSET %s""", params + [per_page, (page - 1) * per_page])
        data = rows(cur)
        cur.execute(f"""SELECT count(*) AS n, coalesce(sum(d.sale_price),0) AS vol,
                        percentile_cont(0.5) WITHIN GROUP (ORDER BY d.sale_price) AS median
                        {BASE} WHERE {where} AND d.sale_price IS NOT NULL""", params)
        pulse = rows(cur)[0]
    return {"total": total, "page": page, "per_page": per_page, "pulse": pulse, "deals": data}


@router.get("/buyers")
def buyers(min_deals: int = 1, rank_by: str = "count", limit: int = 60,
           borough: Optional[str] = None, asset_type: Optional[str] = None,
           price_min: Optional[float] = None, price_max: Optional[float] = None,
           date_min: Optional[str] = None):
    where, params = ["dp.role='buyer'"], []
    for col, val in (("p.borough", borough), ("d.asset_type", asset_type)):
        if val: where.append(f"{col}=%s"); params.append(val)
    for col, val, op in (("d.sale_price", price_min, ">="), ("d.sale_price", price_max, "<="),
                         ("d.sale_date", date_min, ">=")):
        if val is not None: where.append(f"{col} {op} %s"); params.append(val)
    order = "vol DESC" if rank_by == "vol" else "n DESC"
    with db() as conn, conn.cursor() as cur:
        cur.execute(f"""
            SELECT e.entity_id, e.display_name AS name, e.is_spv_suspect,
                   count(*) AS n, coalesce(sum(d.sale_price),0) AS vol,
                   max(d.sale_date) AS last_deal,
                   min(d.sale_price) AS min_price, max(d.sale_price) AS max_price,
                   array_agg(DISTINCT d.asset_type) FILTER (WHERE d.asset_type IS NOT NULL) AS types,
                   array_agg(DISTINCT p.borough) FILTER (WHERE p.borough IS NOT NULL) AS boroughs,
                   EXISTS (SELECT 1 FROM contacts c WHERE c.entity_id = e.entity_id) AS has_contact
            FROM deal_parties dp
            JOIN entities e USING (entity_id)
            JOIN deals d USING (deal_id)
            JOIN properties p USING (property_id)
            WHERE {' AND '.join(where)}
            GROUP BY e.entity_id, e.display_name, e.is_spv_suspect
            HAVING count(*) >= %s
            ORDER BY {order} LIMIT %s""", params + [min_deals, limit])
        return {"buyers": rows(cur)}


@router.get("/leaderboards")
def leaderboards(group_by: str = "asset_type", rank_by: str = "count", top: int = 5):
    col = {"asset_type": "d.asset_type", "borough": "p.borough"}.get(group_by, "d.asset_type")
    metric = "coalesce(sum(d.sale_price),0)" if rank_by == "vol" else "count(*)"
    with db() as conn, conn.cursor() as cur:
        cur.execute(f"""
            SELECT * FROM (
              SELECT {col} AS grp, e.display_name AS name, count(*) AS n,
                     coalesce(sum(d.sale_price),0) AS vol,
                     row_number() OVER (PARTITION BY {col} ORDER BY {metric} DESC) AS rk
              FROM deal_parties dp JOIN entities e USING (entity_id)
              JOIN deals d USING (deal_id) JOIN properties p USING (property_id)
              WHERE dp.role='buyer' AND {col} IS NOT NULL
              GROUP BY {col}, e.display_name) x
            WHERE rk <= %s ORDER BY grp, rk""", (top,))
        return {"boards": rows(cur)}


@router.get("/entities/{entity_id}")
def entity_detail(entity_id: str):
    try:
        uuid.UUID(entity_id)
    except ValueError:
        return {"error": "not found"}  # garbage path segment used to 500 on the cast
    with db() as conn, conn.cursor() as cur:
        cur.execute("SELECT * FROM entities WHERE entity_id=%s", (entity_id,))
        ent = rows(cur)
        if not ent:
            return {"error": "not found"}
        cur.execute("""SELECT dp.role, d.sale_date, p.address_raw AS address, p.borough,
                              d.asset_type, d.sale_price, d.source_url
                       FROM deal_parties dp JOIN deals d USING (deal_id)
                       JOIN properties p USING (property_id)
                       WHERE dp.entity_id=%s ORDER BY d.sale_date DESC NULLS LAST""", (entity_id,))
        deals = rows(cur)
        cur.execute("SELECT contact_id, person_name, phone, email, mailing_address, source FROM contacts WHERE entity_id=%s",
                    (entity_id,))
        contacts = rows(cur)
    return {"entity": ent[0], "deals": deals, "contacts": contacts}
