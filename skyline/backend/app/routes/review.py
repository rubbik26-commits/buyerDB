"""review.py — the needs_review workflow (the 355 migrated flags + upload ambiguities).

Confirming an entity_merge writes an entity_alias (the system gets smarter with use)
and imports the held contact/interaction. Nothing ambiguous is ever merged silently.
"""
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
        where.append("issue_class=%s"); params.append(issue_class)
    with db() as conn, conn.cursor() as cur:
        cur.execute(f"""SELECT review_id, object_type, object_id, issue_class, severity, payload, created_at
                        FROM review_queue WHERE {' AND '.join(where)}
                        ORDER BY created_at DESC LIMIT %s""", params + [limit])
        items = rows(cur)
        cur.execute("SELECT issue_class, count(*) FROM review_queue WHERE status='open' GROUP BY issue_class")
        counts = {r[0]: r[1] for r in cur.fetchall()}
    return {"items": items, "open_counts": counts}


class ReviewAction(BaseModel):
    review_id: str
    action: str                      # 'resolve' | 'dismiss' | 'confirm_merge'
    entity_id: Optional[str] = None  # for confirm_merge: the chosen entity
    user_id: Optional[str] = "system"


@router.post("/review/act")
def act(a: ReviewAction):
    # A typo'd action must never fall through to "dismissed" — that would be an
    # accidental auto-resolution of a flagged conflict (invariant 3).
    if a.action not in ALLOWED_ACTIONS:
        return {"error": f"unknown action {a.action!r}; allowed: {sorted(ALLOWED_ACTIONS)}"}
    with db() as conn, conn.cursor() as cur:
        # only OPEN items are actionable: re-acting an already-resolved merge
        # would re-import its contact a second time
        cur.execute("""SELECT object_type, object_id, issue_class, payload, status
                       FROM review_queue WHERE review_id=%s""", (a.review_id,))
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
            cur.execute("SELECT 1 FROM entities WHERE entity_id=%s", (a.entity_id,))
            if not cur.fetchone():
                return {"error": "entity_id does not exist"}
            from shared.normalize import norm_entity
            name = (payload or {}).get("name")
            nn = norm_entity(name) if name else None
            if nn:                        # remember this decision as an alias
                cur.execute("""INSERT INTO entity_aliases (entity_id, alias_norm, source)
                               VALUES (%s,%s,'review_confirm') ON CONFLICT (alias_norm) DO NOTHING""",
                            (a.entity_id, nn))
                if cur.rowcount == 0:
                    # the alias already maps somewhere — if it's a DIFFERENT
                    # entity, silently keeping the old mapping would discard
                    # the reviewer's decision (invariant 3: flag, don't drop)
                    cur.execute("SELECT entity_id FROM entity_aliases WHERE alias_norm=%s", (nn,))
                    existing = cur.fetchone()
                    if existing and str(existing[0]) != str(a.entity_id):
                        cur.execute("""INSERT INTO review_queue (object_type, object_id, issue_class, payload)
                                       VALUES ('entity_alias', %s, 'alias_conflict', %s)""",
                                    (nn, json.dumps({"alias_norm": nn,
                                                     "mapped_entity_id": str(existing[0]),
                                                     "requested_entity_id": a.entity_id,
                                                     "review_id": a.review_id})))
            # import the held contact/interaction against the confirmed entity
            if object_type == "upload_row" and payload:
                raw = payload.get("raw") or {}
                mapping = payload.get("mapping") or {}
                inv = {}
                for src, canon in mapping.items():
                    inv.setdefault(canon, src)
                def val(raw_, canon):
                    src = inv.get(canon)
                    return raw_.get(src) if src else None

                class _B:  # minimal shim for _import_contact
                    upload_id = object_id.split(":")[0]
                    user_id = a.user_id
                stats = {"contacts_created": 0, "interactions_created": 0,
                         "skipped_undated_notes": 0}
                _import_contact(cur, a.entity_id, raw, val, _B(), stats)
                un, rn = object_id.split(":")
                cur.execute("UPDATE upload_rows SET status='imported', resolution=%s WHERE upload_id=%s AND row_num=%s",
                            (json.dumps({"entity_id": a.entity_id, "method": "review_confirm"}), un, int(rn)))
            cur.execute("""UPDATE review_queue SET status='resolved', resolved_by=%s, resolved_at=now()
                           WHERE review_id=%s""", (a.user_id, a.review_id))
            return {"status": "merged", "entity_id": a.entity_id}

        new_status = "resolved" if a.action == "resolve" else "dismissed"
        cur.execute("""UPDATE review_queue SET status=%s, resolved_by=%s, resolved_at=now()
                       WHERE review_id=%s""", (new_status, a.user_id, a.review_id))
        return {"status": new_status}
