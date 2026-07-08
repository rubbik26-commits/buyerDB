"""workbench.py — broker-facing workflow layer adapted from dealflow-insights.

This is not a replacement schema. It sits on top of the canonical buyerDB tables
and exposes the product workflows dealflow-insights had in the UI.
"""
import json
from typing import Optional

from fastapi import APIRouter, Query
from pydantic import BaseModel

from ..db import db, rows

router = APIRouter(prefix="/api")


class InteractionCreate(BaseModel):
    entity_id: str
    user_id: str = "broker"
    contact_id: Optional[str] = None
    channel: str = "other"
    occurred_at: Optional[str] = None
    subject: Optional[str] = None
    notes: Optional[str] = None
    outcome: Optional[str] = None


class ScrapeRunRequest(BaseModel):
    job: str
    user_id: str = "broker"
    options: Optional[dict] = None


@router.get("/workbench")
def workbench():
    """Executive command center: the fastest answer to what should I work now?"""
    with db() as conn, conn.cursor() as cur:
        cur.execute("""
            SELECT count(*) AS deals,
                   count(*) FILTER (WHERE sale_price IS NOT NULL) AS priced_deals,
                   coalesce(sum(sale_price),0) AS total_volume
            FROM deals
        """)
        stats = rows(cur)[0]
        cur.execute("SELECT count(DISTINCT entity_id) AS unique_buyers FROM deal_parties WHERE role='buyer'")
        stats.update(rows(cur)[0])
        cur.execute("SELECT count(DISTINCT entity_id) AS unique_sellers FROM deal_parties WHERE role='seller'")
        stats.update(rows(cur)[0])
        cur.execute("SELECT count(*) AS open_reviews FROM review_queue WHERE status='open'")
        stats.update(rows(cur)[0])
        cur.execute("SELECT count(*) AS contacts FROM contacts")
        stats.update(rows(cur)[0])
        cur.execute("""
            SELECT count(*) AS contact_gaps
            FROM (
              SELECT e.entity_id
              FROM deal_parties dp
              JOIN entities e USING (entity_id)
              LEFT JOIN contacts c ON c.entity_id=e.entity_id
              WHERE dp.role='buyer'
              GROUP BY e.entity_id
              HAVING count(*) >= 2 AND count(c.contact_id)=0
            ) x
        """)
        stats.update(rows(cur)[0])

        cur.execute("""
            SELECT e.entity_id, e.display_name AS name,
                   count(*) AS deal_count,
                   coalesce(sum(d.sale_price),0) AS volume,
                   max(d.sale_date) AS last_deal,
                   array_remove(array_agg(DISTINCT d.asset_type), NULL) AS asset_types,
                   array_remove(array_agg(DISTINCT p.borough), NULL) AS boroughs
            FROM deal_parties dp
            JOIN entities e USING (entity_id)
            JOIN deals d USING (deal_id)
            JOIN properties p USING (property_id)
            LEFT JOIN contacts c ON c.entity_id=e.entity_id
            WHERE dp.role='buyer'
            GROUP BY e.entity_id, e.display_name
            HAVING count(*) >= 2 AND count(c.contact_id)=0
            ORDER BY coalesce(sum(d.sale_price),0) DESC NULLS LAST, count(*) DESC
            LIMIT 10
        """)
        contact_gaps = rows(cur)

        cur.execute("""
            WITH latest AS (
              SELECT DISTINCT ON (p.property_id)
                     p.property_id, p.address_raw AS address, p.borough, p.market,
                     d.deal_id, d.sale_date, d.sale_price, d.asset_type,
                     be.entity_id AS owner_entity_id, be.display_name AS known_owner
              FROM properties p
              JOIN deals d USING (property_id)
              LEFT JOIN deal_parties bdp ON bdp.deal_id=d.deal_id AND bdp.role='buyer'
              LEFT JOIN entities be ON be.entity_id=bdp.entity_id
              ORDER BY p.property_id, d.sale_date DESC NULLS LAST, d.created_at DESC
            )
            SELECT latest.*,
                   EXISTS (SELECT 1 FROM contacts c WHERE c.entity_id=latest.owner_entity_id) AS has_contact,
                   EXISTS (SELECT 1 FROM interactions i WHERE i.entity_id=latest.owner_entity_id) AS has_interaction
            FROM latest
            WHERE owner_entity_id IS NOT NULL
            ORDER BY sale_price DESC NULLS LAST, sale_date DESC NULLS LAST
            LIMIT 10
        """)
        owner_targets = rows(cur)

        cur.execute("""
            SELECT review_id, object_type, object_id, issue_class, severity, payload, created_at
            FROM review_queue
            WHERE status='open'
            ORDER BY created_at DESC
            LIMIT 10
        """)
        review_items = rows(cur)

        cur.execute("""
            SELECT run_id, job, started_at, finished_at, status, stats, error
            FROM scrape_runs
            ORDER BY started_at DESC
            LIMIT 8
        """)
        scrape_runs = rows(cur)

    return {"stats": stats, "contact_gaps": contact_gaps, "owner_targets": owner_targets, "review_items": review_items, "scrape_runs": scrape_runs}


@router.get("/properties")
def properties(q: Optional[str] = None, borough: Optional[str] = None, asset_type: Optional[str] = None, contact_gap: bool = False, page: int = Query(1, ge=1), per_page: int = Query(50, ge=1, le=200)):
    where = ["1=1"]
    params = []
    if q:
        where.append("(p.address_raw ILIKE %s OR p.bbl ILIKE %s OR be.display_name ILIKE %s OR se.display_name ILIKE %s)")
        params.extend([f"%{q}%"] * 4)
    if borough:
        where.append("p.borough=%s")
        params.append(borough)
    if asset_type:
        where.append("d.asset_type=%s")
        params.append(asset_type)
    if contact_gap:
        where.append("be.entity_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM contacts c WHERE c.entity_id=be.entity_id)")

    base = f"""
        WITH latest AS (
          SELECT DISTINCT ON (p.property_id)
                 p.property_id, p.address_raw AS address, p.address_norm, p.borough,
                 p.market, p.zip, p.bbl, p.units AS property_units, p.sqft AS property_sqft,
                 d.deal_id, d.sale_date, d.sale_price, d.asset_type, d.units AS deal_units,
                 d.sqft AS deal_sqft, d.source_system, d.source_url,
                 be.entity_id AS owner_entity_id, be.display_name AS current_owner,
                 se.entity_id AS seller_entity_id, se.display_name AS seller
          FROM properties p
          JOIN deals d USING (property_id)
          LEFT JOIN deal_parties bdp ON bdp.deal_id=d.deal_id AND bdp.role='buyer'
          LEFT JOIN entities be ON be.entity_id=bdp.entity_id
          LEFT JOIN deal_parties sdp ON sdp.deal_id=d.deal_id AND sdp.role='seller'
          LEFT JOIN entities se ON se.entity_id=sdp.entity_id
          WHERE {' AND '.join(where)}
          ORDER BY p.property_id, d.sale_date DESC NULLS LAST, d.created_at DESC
        )
    """
    with db() as conn, conn.cursor() as cur:
        cur.execute(base + "SELECT count(*) FROM latest", params)
        total = cur.fetchone()[0]
        cur.execute(base + """
            SELECT latest.*,
                   EXISTS (SELECT 1 FROM contacts c WHERE c.entity_id=latest.owner_entity_id) AS has_contact,
                   (SELECT max(i.occurred_at) FROM interactions i WHERE i.entity_id=latest.owner_entity_id) AS last_interaction,
                   (SELECT count(*) FROM deals d2 WHERE d2.property_id=latest.property_id) AS deal_count
            FROM latest
            ORDER BY sale_date DESC NULLS LAST, sale_price DESC NULLS LAST, address
            LIMIT %s OFFSET %s
        """, params + [per_page, (page - 1) * per_page])
        data = rows(cur)
    return {"total": total, "page": page, "per_page": per_page, "properties": data}


@router.get("/tasks")
def tasks(limit: int = Query(50, ge=1, le=200)):
    task_rows = []
    with db() as conn, conn.cursor() as cur:
        cur.execute("""
            SELECT e.entity_id, e.display_name AS name, count(*) AS deal_count, coalesce(sum(d.sale_price),0) AS volume, max(d.sale_date) AS last_deal
            FROM deal_parties dp JOIN entities e USING (entity_id) JOIN deals d USING (deal_id) LEFT JOIN contacts c ON c.entity_id=e.entity_id
            WHERE dp.role='buyer'
            GROUP BY e.entity_id, e.display_name
            HAVING count(*) >= 2 AND count(c.contact_id)=0
            ORDER BY volume DESC NULLS LAST, deal_count DESC
            LIMIT %s
        """, (limit,))
        for r in rows(cur):
            task_rows.append({"kind": "contact_gap", "priority": "high" if (r.get("volume") or 0) >= 25_000_000 else "normal", "entity_id": r["entity_id"], "title": f"Find phone/email for {r['name']}", "detail": f"{r['deal_count']} buyer deals - last deal {r.get('last_deal') or 'unknown'}", "metric": r.get("volume")})
        cur.execute("""SELECT review_id, issue_class, severity, object_type, object_id, created_at FROM review_queue WHERE status='open' ORDER BY created_at DESC LIMIT %s""", (limit,))
        for r in rows(cur):
            task_rows.append({"kind": "review", "priority": r.get("severity") or "normal", "review_id": r["review_id"], "title": f"Review {r['issue_class']}", "detail": f"{r['object_type']} - {r['object_id']}", "metric": None, "created_at": r.get("created_at")})
        cur.execute("""
            WITH last_touch AS (SELECT entity_id, max(occurred_at) AS last_interaction FROM interactions GROUP BY entity_id)
            SELECT e.entity_id, e.display_name AS name, count(*) AS deal_count, coalesce(sum(d.sale_price),0) AS volume, max(d.sale_date) AS last_deal, lt.last_interaction
            FROM deal_parties dp JOIN entities e USING (entity_id) JOIN deals d USING (deal_id) LEFT JOIN last_touch lt ON lt.entity_id=e.entity_id
            WHERE dp.role='buyer'
            GROUP BY e.entity_id, e.display_name, lt.last_interaction
            HAVING count(*) >= 3 AND (lt.last_interaction IS NULL OR lt.last_interaction < now() - interval '90 days')
            ORDER BY volume DESC NULLS LAST, deal_count DESC
            LIMIT %s
        """, (limit,))
        for r in rows(cur):
            task_rows.append({"kind": "buyer_followup", "priority": "normal", "entity_id": r["entity_id"], "title": f"Follow up with active buyer {r['name']}", "detail": f"{r['deal_count']} purchases - last touch {r.get('last_interaction') or 'never logged'}", "metric": r.get("volume")})
    task_rows.sort(key=lambda r: ({"high": 0, "normal": 1, "low": 2}.get(r.get("priority"), 1), -(float(r.get("metric") or 0))))
    return {"tasks": task_rows[:limit]}


@router.post("/interactions")
def create_interaction(body: InteractionCreate):
    channel = (body.channel or "other").lower()
    if channel not in {"call", "email", "text", "meeting", "mail", "other"}:
        channel = "other"
    with db() as conn, conn.cursor() as cur:
        cur.execute("SELECT 1 FROM entities WHERE entity_id=%s", (body.entity_id,))
        if not cur.fetchone():
            return {"error": "entity not found"}
        cur.execute("""
            INSERT INTO interactions (entity_id, contact_id, user_id, channel, occurred_at, subject, notes, outcome)
            VALUES (%s,%s,%s,%s,coalesce(%s::timestamptz, now()),%s,%s,%s)
            RETURNING interaction_id, entity_id, contact_id, user_id, channel, occurred_at, subject, notes, outcome
        """, (body.entity_id, body.contact_id, body.user_id, channel, body.occurred_at, body.subject, body.notes, body.outcome))
        return {"interaction": rows(cur)[0]}


@router.get("/scrapers/runs")
def scrape_runs(limit: int = Query(50, ge=1, le=200)):
    with db() as conn, conn.cursor() as cur:
        cur.execute("SELECT run_id, job, started_at, finished_at, status, stats, error FROM scrape_runs ORDER BY started_at DESC LIMIT %s", (limit,))
        return {"runs": rows(cur)}


@router.post("/scrapers/request")
def request_scrape(body: ScrapeRunRequest):
    allowed = {"traded_refresh", "acris_refresh", "crexi_refresh", "property_owner_refresh", "full_refresh"}
    job = body.job if body.job in allowed else "full_refresh"
    payload = {"requested_by": body.user_id, "options": body.options or {}}
    with db() as conn, conn.cursor() as cur:
        cur.execute("""
            INSERT INTO scrape_runs (job, status, stats)
            VALUES (%s, 'requested', %s)
            RETURNING run_id, job, started_at, finished_at, status, stats, error
        """, (job, json.dumps(payload)))
        return {"run": rows(cur)[0]}
