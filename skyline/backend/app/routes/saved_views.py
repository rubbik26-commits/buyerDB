"""Saved views API for filters/sorts across workflow surfaces."""
import json
from typing import Optional

from fastapi import APIRouter
from pydantic import BaseModel, Field

from ..db import db, rows

router = APIRouter(prefix="/api/saved-views")


class SavedViewUpsert(BaseModel):
    user_id: str = "broker"
    name: str
    surface: str
    filters: dict = Field(default_factory=dict)
    sort: dict = Field(default_factory=dict)


@router.get("")
def list_views(user_id: str = "broker", surface: Optional[str] = None):
    where = ["user_id=%s"]
    params = [user_id]
    if surface:
        where.append("surface=%s")
        params.append(surface)
    with db() as conn, conn.cursor() as cur:
        cur.execute(f"""
            SELECT view_id, user_id, name, surface, filters, sort, created_at, updated_at
            FROM saved_views
            WHERE {' AND '.join(where)}
            ORDER BY surface, updated_at DESC
        """, params)
        return {"views": rows(cur)}


@router.post("")
def upsert_view(body: SavedViewUpsert):
    if body.surface not in {"deals", "buyers", "properties", "outreach", "audit"}:
        return {"error": "invalid saved-view surface"}
    name = body.name.strip()
    if not name:
        return {"error": "saved-view name is required"}
    with db() as conn, conn.cursor() as cur:
        cur.execute("""
            INSERT INTO saved_views (user_id, name, surface, filters, sort)
            VALUES (%s,%s,%s,%s,%s)
            ON CONFLICT (user_id, surface, name)
            DO UPDATE SET filters=EXCLUDED.filters, sort=EXCLUDED.sort, updated_at=now()
            RETURNING view_id, user_id, name, surface, filters, sort, created_at, updated_at
        """, (body.user_id, name, body.surface, json.dumps(body.filters), json.dumps(body.sort)))
        return {"view": rows(cur)[0]}


@router.delete("/{view_id}")
def delete_view(view_id: str, user_id: str = "broker"):
    with db() as conn, conn.cursor() as cur:
        cur.execute("DELETE FROM saved_views WHERE view_id=%s AND user_id=%s RETURNING view_id", (view_id, user_id))
        deleted = cur.fetchone()
    return {"deleted": bool(deleted), "view_id": view_id}
