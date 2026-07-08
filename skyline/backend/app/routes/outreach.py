"""Outreach API.

This is a credential-free replacement for the useful Email Center workflow from
dealflow-insights. It does not send mail or invent contact details. It builds
broker-reviewable target lists and persists drafts from contacts + real buyer history.
"""
from typing import Optional

from fastapi import APIRouter, Query
from pydantic import BaseModel

from ..db import db, rows

router = APIRouter(prefix="/api/outreach")


class DraftRequest(BaseModel):
    entity_id: str
    property_summary: Optional[str] = None
    tone: Optional[str] = "direct"
    user_id: str = "broker"


@router.get("/targets")
def targets(asset_type: Optional[str] = None,
            borough: Optional[str] = None,
            price_min: Optional[float] = None,
            price_max: Optional[float] = None,
            require_email: bool = False,
            limit: int = Query(75, ge=1, le=250)):
    where = ["dp.role='buyer'"]
    params = []
    if asset_type:
        where.append("d.asset_type=%s")
        params.append(asset_type)
    if borough:
        where.append("p.borough=%s")
        params.append(borough)
    if price_min is not None:
        where.append("d.sale_price >= %s")
        params.append(price_min)
    if price_max is not None:
        where.append("d.sale_price <= %s")
        params.append(price_max)
    email_filter = "WHERE cc.email_count > 0" if require_email else ""
    with db() as conn, conn.cursor() as cur:
        cur.execute(f"""
            WITH buyer_activity AS (
              SELECT e.entity_id, e.display_name AS name, e.is_spv_suspect,
                     count(d.deal_id) AS deal_count,
                     coalesce(sum(d.sale_price),0) AS volume,
                     max(d.sale_date) AS last_deal,
                     array_remove(array_agg(DISTINCT d.asset_type), NULL) AS asset_types,
                     array_remove(array_agg(DISTINCT p.borough), NULL) AS boroughs
              FROM deal_parties dp
              JOIN entities e USING (entity_id)
              JOIN deals d USING (deal_id)
              JOIN properties p USING (property_id)
              WHERE {' AND '.join(where)}
              GROUP BY e.entity_id, e.display_name, e.is_spv_suspect
            ), contact_counts AS (
              SELECT entity_id,
                     count(*) AS contact_count,
                     count(*) FILTER (WHERE nullif(email,'') IS NOT NULL) AS email_count,
                     count(*) FILTER (WHERE nullif(phone,'') IS NOT NULL) AS phone_count
              FROM contacts
              GROUP BY entity_id
            )
            SELECT ba.*, coalesce(cc.contact_count,0) AS contact_count,
                   coalesce(cc.email_count,0) AS email_count,
                   coalesce(cc.phone_count,0) AS phone_count
            FROM buyer_activity ba
            LEFT JOIN contact_counts cc USING (entity_id)
            {email_filter}
            ORDER BY ba.volume DESC NULLS LAST, ba.deal_count DESC
            LIMIT %s
        """, params + [limit])
        target_rows = rows(cur)
    return {"filters": {"asset_type": asset_type, "borough": borough, "require_email": require_email}, "targets": target_rows}


@router.get("/drafts")
def drafts(user_id: str = "broker", limit: int = Query(50, ge=1, le=200)):
    with db() as conn, conn.cursor() as cur:
        cur.execute("""
            SELECT od.draft_id, od.entity_id, e.display_name AS entity_name, od.user_id,
                   od.property_summary, od.subject, od.body, od.status, od.created_at, od.updated_at
            FROM outreach_drafts od
            JOIN entities e USING (entity_id)
            WHERE od.user_id=%s
            ORDER BY od.created_at DESC
            LIMIT %s
        """, (user_id, limit))
        return {"drafts": rows(cur)}


@router.post("/draft")
def draft(body: DraftRequest):
    with db() as conn, conn.cursor() as cur:
        cur.execute("SELECT entity_id, display_name FROM entities WHERE entity_id=%s", (body.entity_id,))
        ent = rows(cur)
        if not ent:
            return {"error": "entity not found"}
        entity = ent[0]
        cur.execute("""
            SELECT person_name, title, phone, email, mailing_address, source, is_primary
            FROM contacts
            WHERE entity_id=%s
            ORDER BY is_primary DESC, confidence DESC, created_at DESC
        """, (body.entity_id,))
        contacts = rows(cur)
        cur.execute("""
            SELECT d.sale_date, p.address_raw AS address, p.borough, d.asset_type, d.sale_price
            FROM deal_parties dp
            JOIN deals d USING (deal_id)
            JOIN properties p USING (property_id)
            WHERE dp.entity_id=%s AND dp.role='buyer'
            ORDER BY d.sale_date DESC NULLS LAST
            LIMIT 5
        """, (body.entity_id,))
        recent = rows(cur)

        recent_line = ""
        if recent:
            bits = [f"{r['address']} ({r.get('borough') or 'NYC'}, {r.get('asset_type') or 'asset'}, ${int(r['sale_price']):,})" for r in recent if r.get("sale_price")]
            if bits:
                recent_line = " I noticed your recent activity including " + "; ".join(bits[:3]) + "."
        property_line = f" I am reaching out about {body.property_summary.strip()}." if body.property_summary else " I am reaching out about a potential NYC investment sale opportunity."
        subject = "NYC investment sale opportunity"
        greeting = "Hi," if not contacts or not contacts[0].get("person_name") else f"Hi {contacts[0]['person_name'].split()[0]},"
        message = (
            f"{greeting}\n\n"
            f"{property_line}{recent_line}\n\n"
            "Given your transaction history, I thought this may be worth putting in front of you. "
            "If it is not a fit, no problem — I would still appreciate knowing what you are focused on right now.\n\n"
            "Best,\nRobert"
        )
        cur.execute("""
            INSERT INTO outreach_drafts (entity_id, user_id, property_summary, subject, body)
            VALUES (%s,%s,%s,%s,%s)
            RETURNING draft_id, status, created_at
        """, (body.entity_id, body.user_id, body.property_summary, subject, message))
        draft_row = rows(cur)[0]
    return {"entity": entity, "contacts": contacts, "recent_deals": recent, "subject": subject, "body": message, "draft": draft_row}
