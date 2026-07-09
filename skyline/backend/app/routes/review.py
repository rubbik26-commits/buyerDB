"""review.py — needs_review workflow over the live sbi_* schema."""
import json
import uuid as uuid_mod
from fastapi import APIRouter
from pydantic import BaseModel
from typing import Optional
from ..db import db, rows
from ..routes.uploads import _import_contact

router = APIRouter(prefix="/api")
ALLOWED_ACTIONS = {"resolve", "dismiss", "confirm_merge"}


@router.get("/review")
def list_review(status: str = "open", issue_class: Optional[str] = None, limit: int = 50):
    where, params = ["status=%s"], [status]
    if issue_class:
        where.append("issue_class=%s")
        params.append(issue_class)
    with db() as conn, conn.cursor() as cur:
        cur.execute(f"""SELECT review_id, object_type, object_id, issue_class, severity, payload, created_at
                        FROM sbi_review_queue WHERE {' AND '.join(where)}
                        ORDER BY created_at DESC LIMIT %s""", params + [limit])
        items = rows(cur)
        cur.execute("SELECT issue_class, count(*) FROM sbi_review_queue WHERE status='open' GROUP BY issue_class")
        counts = {r[0]: r[1] for r in cur.fetchall()}
    return {"items": items, "open_counts": counts}


class ReviewAction(BaseModel):
    review_id: str
    action: str
    entity_id: Optional[str] = None
    user_id: Optional[str] = "system"


@router.post("/review/act")
def act(a: ReviewAction):
    if a.action not in ALLOWED_ACTIONS:
        return {"error": f"unknown action {a.action!r}; allowed: {sorted(ALLOWED_ACTIONS)}"}
    with db() as conn, conn.cursor() as cur:
        cur.execute("""SELECT object_type, object_id, issue_class, payload, status
                       FROM sbi_review_queue WHERE review_id=%s""", (a.review_id,))
        row = cur.fetchone()
        if not row:
            return {"error": "review item not found"}
        object_type, object_id, issue_class, payload, cur_status = row
        if cur_status != "open":
            return {"error": f"review item is already {cur_status}"}

        if a.action == "confirm_merge":
            if not a.entity_id:
                return {"error": "confirm_merge requires entity_id"}
            try:
                uuid_mod.UUID(a.entity_id)
            except ValueError:
                return {"error": "entity_id is not a valid UUID"}
            cur.execute("SELECT 1 FROM sbi_entities WHERE entity_id=%s", (a.entity_id,))
            if not cur.fetchone():
                return {"error": "entity_id does not exist"}
            from shared.normalize import norm_entity
            name = (payload or {}).get("name")
            nn = norm_entity(name) if name else None
            if nn:
                cur.execute("""INSERT INTO sbi_entity_aliases (entity_id, alias_raw, source)
                               VALUES (%s,%s,'review_confirm') ON CONFLICT (entity_id, alias_norm, source) DO NOTHING""",
                            (a.entity_id, name or nn))
            if object_type == "upload_row" and payload:
                raw = payload.get("raw") or {}
                mapping = payload.get("mapping") or {}
                inv = {}
                for src, canon in mapping.items():
                    inv.setdefault(canon, src)

                def val(raw_, canon):
                    src = inv.get(canon)
                    return raw_.get(src) if src else None

                class _B:
                    upload_id = object_id.split(":")[0]
                    user_id = a.user_id

                stats = {"contacts_created": 0, "interactions_created": 0,
                         "skipped_undated_notes": 0}
                _import_contact(cur, a.entity_id, raw, val, _B(), stats)
                un, rn = object_id.split(":")
                cur.execute("UPDATE sbi_upload_rows SET status='imported', resolution=%s::jsonb WHERE upload_id=%s AND row_num=%s",
                            (json.dumps({"entity_id": a.entity_id, "method": "review_confirm"}), un, int(rn)))
            cur.execute("""UPDATE sbi_review_queue SET status='resolved', resolved_by=%s, resolved_at=now()
                           WHERE review_id=%s""", (a.user_id, a.review_id))
            return {"status": "merged", "entity_id": a.entity_id}

        new_status = "resolved" if a.action == "resolve" else "dismissed"
        cur.execute("""UPDATE sbi_review_queue SET status=%s, resolved_by=%s, resolved_at=now()
                       WHERE review_id=%s""", (new_status, a.user_id, a.review_id))
        return {"status": new_status}
