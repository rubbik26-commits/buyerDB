"""uploads.py — user CSV/Excel ingestion (§8-9).

Flow: upload -> stage rows verbatim -> propose column mapping -> confirm ->
normalize + resolve entities -> import contacts/interactions (auto-matched) or
queue ambiguous rows for review. NOTE: this path imports CONTACT/INTERACTION
shapes only — deal-shaped uploads are not implemented here; deals enter through
store.merge_deal (worker) or sync_upsert_deals (SQL), where the exclusion
ledger, no_residential, and dedupe gates live.

Everything is server-side (pandas/openpyxl) so the same normalize functions that
built the dataset apply to uploads too.
"""
import io, json, uuid
import pandas as pd
from fastapi import APIRouter, UploadFile, File, Form
from pydantic import BaseModel
from typing import Optional
from ..db import db, rows
from ..services import entity_resolution
from shared.normalize import norm_entity, is_placeholder, entity_type

MAX_UPLOAD_BYTES = 20 * 1024 * 1024  # unauthenticated multi-GB reads are a memory DoS

router = APIRouter(prefix="/api")

# header synonym -> canonical field
SYNONYMS = {
    "entity_name": ["owner", "entity", "company", "buyer", "seller", "name", "llc", "borrower", "landlord"],
    "person_name": ["contact", "contact_name", "person", "principal", "rep", "broker"],
    "phone": ["phone", "tel", "telephone", "mobile", "cell", "phone_number"],
    "email": ["email", "e-mail", "mail", "email_address"],
    "mailing_address": ["address", "mailing", "mailing_address", "street", "location"],
    "title": ["title", "role", "position"],
    "last_contact_date": ["last_contact", "last_contacted", "last_contact_date", "contacted_on", "date"],
    "interaction_notes": ["notes", "note", "comment", "comments", "remarks"],
    "channel": ["channel", "method", "via"],
}


def _sniff_mapping(columns):
    """Score each (column, field) and assign the best-scoring field per column.
    Exact canonical/synonym match (3) > multi-word synonym phrase-in-column (2) >
    whole-token synonym match (1). Bare substring matching is deliberately NOT used:
    it let 'name' hijack 'contact_name' and 'contact' hijack 'contacted'."""
    mapping = {}
    for col in columns:
        c = str(col).strip().lower().replace(" ", "_").replace("-", "_")
        tokens = set(c.split("_"))
        best_field, best_score = None, 0
        for canon, syns in SYNONYMS.items():
            score = 0
            if c == canon or c in syns:
                score = 3
            else:
                for s in syns:
                    s_norm = s.replace("-", "_")
                    if "_" in s_norm and s_norm in c:          # multi-word phrase present, e.g. 'last_contacted'
                        score = max(score, 2)
                    elif s_norm in tokens:                     # whole-token match, e.g. token 'phone'
                        score = max(score, 1)
            if score > best_score:
                best_field, best_score = canon, score
        if best_field:
            mapping[col] = best_field
    return mapping


@router.post("/uploads")
async def create_upload(file: UploadFile = File(...), user_id: str = Form("system")):
    """Stage an uploaded CSV/XLSX: parse rows verbatim into upload_rows, propose a mapping."""
    content = await file.read()
    if len(content) > MAX_UPLOAD_BYTES:
        return {"error": f"file too large (max {MAX_UPLOAD_BYTES // (1024 * 1024)} MB)"}
    name = (file.filename or "upload").lower()
    try:
        if name.endswith((".xlsx", ".xls")):
            df = pd.read_excel(io.BytesIO(content))
        else:
            df = pd.read_csv(io.BytesIO(content))
    except Exception as e:
        return {"error": f"could not parse file: {e}"}
    # astype(object) first: plain .where() leaves float-column NaNs intact, and
    # they staged as the string "nan" — which then imported as phone='nan'
    df = df.astype(object).where(pd.notna(df), None)
    mapping = _sniff_mapping(list(df.columns))
    with db() as conn, conn.cursor() as cur:
        cur.execute("""INSERT INTO uploads (user_id, filename, row_count, column_mapping, status)
                       VALUES (%s,%s,%s,%s,'staged') RETURNING upload_id""",
                    (user_id, file.filename, len(df), json.dumps(mapping)))
        upload_id = cur.fetchone()[0]
        for i, row in df.iterrows():
            cur.execute("INSERT INTO upload_rows (upload_id, row_num, raw) VALUES (%s,%s,%s)",
                        (upload_id, int(i), json.dumps({str(k): (None if v is None else str(v))
                                                        for k, v in row.items()})))
    # df is all-object with None for missing values by here, so the sample
    # serializes as valid JSON (float NaN would emit literal NaN and break
    # the browser's JSON.parse)
    return {"upload_id": str(upload_id), "row_count": len(df), "columns": list(df.columns),
            "proposed_mapping": mapping, "sample": df.head(5).to_dict("records")}


class MappingConfirm(BaseModel):
    upload_id: str
    mapping: dict           # {source_col: canonical_field}
    user_id: Optional[str] = "system"


@router.post("/uploads/resolve")
def resolve_upload(body: MappingConfirm):
    """Apply the confirmed mapping, normalize, resolve each row's entity, and import.
    auto_matched -> contacts (+ interaction if history columns present).
    needs_review -> review_queue with candidates. no_match -> a new entity is created
    (a brand-new contact for an owner we've never seen is legitimate)."""
    inv = {}
    for src, canon in body.mapping.items():
        inv.setdefault(canon, src)
    if "entity_name" not in inv:
        return {"error": "mapping must include an entity_name column"}

    stats = {"auto_matched": 0, "needs_review": 0, "new_entity": 0, "contacts_created": 0,
             "interactions_created": 0, "skipped_no_name": 0, "skipped_undated_notes": 0}
    with db() as conn, conn.cursor() as cur:
        cur.execute("SELECT status FROM uploads WHERE upload_id=%s", (body.upload_id,))
        u = cur.fetchone()
        if not u:
            return {"error": "upload not found"}
        if u[0] == "imported":
            # re-POSTing (double-click, retry after timeout) must not duplicate
            # every contact and interaction
            return {"error": "upload already imported", "upload_id": body.upload_id}
        cur.execute("UPDATE uploads SET column_mapping=%s, status='resolving' WHERE upload_id=%s",
                    (json.dumps(body.mapping), body.upload_id))
        cur.execute("""SELECT row_num, raw FROM upload_rows
                       WHERE upload_id=%s AND status IS DISTINCT FROM 'imported'
                       ORDER BY row_num""", (body.upload_id,))
        staged = cur.fetchall()

        def val(raw, canon):
            src = inv.get(canon)
            v = raw.get(src) if src else None
            if v is None:
                return None
            s = str(v).strip()
            return None if not s or s.lower() in ("nan", "none", "null") else s

        for row_num, raw in staged:
            ename = val(raw, "entity_name")
            if not ename or is_placeholder(str(ename)):
                stats["skipped_no_name"] += 1
                cur.execute("UPDATE upload_rows SET status='rejected', resolution=%s WHERE upload_id=%s AND row_num=%s",
                            (json.dumps({"reason": "no entity name"}), body.upload_id, row_num))
                continue
            address = val(raw, "mailing_address")
            res = entity_resolution.resolve(cur, ename, address)

            if res["status"] == "needs_review":
                stats["needs_review"] += 1
                cur.execute("UPDATE upload_rows SET status='needs_review', resolution=%s WHERE upload_id=%s AND row_num=%s",
                            (json.dumps(res), body.upload_id, row_num))
                cur.execute("""INSERT INTO review_queue (object_type, object_id, issue_class, payload)
                               VALUES ('upload_row', %s, 'entity_merge', %s)""",
                            (f"{body.upload_id}:{row_num}",
                             json.dumps({"name": ename, "candidates": res["candidates"],
                                         "raw": raw, "mapping": body.mapping})))
                continue

            if res["status"] == "auto_matched":
                entity_id = res["entity_id"]; stats["auto_matched"] += 1
            else:  # no_match -> create a new entity
                nn = norm_entity(ename)
                cur.execute("""INSERT INTO entities (display_name, norm_name, entity_type)
                               VALUES (%s,%s,%s) ON CONFLICT (norm_name) DO UPDATE SET norm_name=EXCLUDED.norm_name
                               RETURNING entity_id""", (str(ename).strip(), nn, entity_type(nn)))
                entity_id = str(cur.fetchone()[0]); stats["new_entity"] += 1

            _import_contact(cur, entity_id, raw, val, body, stats)
            cur.execute("UPDATE upload_rows SET status='imported', resolution=%s WHERE upload_id=%s AND row_num=%s",
                        (json.dumps({"entity_id": entity_id, "method": res["method"]}), body.upload_id, row_num))

        cur.execute("UPDATE uploads SET status='imported' WHERE upload_id=%s", (body.upload_id,))
    return {"upload_id": body.upload_id, "stats": stats}


def _import_contact(cur, entity_id, raw, val, body, stats):
    phone = val(raw, "phone"); email = val(raw, "email")
    person = val(raw, "person_name"); title = val(raw, "title")
    mail = val(raw, "mailing_address")
    if any([phone, email, person, mail]):
        cur.execute("""INSERT INTO contacts (entity_id, person_name, title, phone, email,
                                             mailing_address, source, created_by)
                       VALUES (%s,%s,%s,%s,%s,%s,%s,%s)""",
                    (entity_id, person, title, phone, email, mail,
                     f"upload:{body.upload_id}", body.user_id))
        stats["contacts_created"] += 1
    when = val(raw, "last_contact_date"); notes = val(raw, "interaction_notes")
    channel = (val(raw, "channel") or "other")
    if when or notes:
        try:
            ts = pd.to_datetime(when).isoformat() if when else None
        except Exception:
            ts = None
        if ts:
            ch = str(channel).lower()
            ch = ch if ch in ("call", "email", "text", "meeting", "mail", "other") else "other"
            cur.execute("""INSERT INTO interactions (entity_id, user_id, channel, occurred_at, notes)
                           VALUES (%s,%s,%s,%s,%s)""", (entity_id, body.user_id, ch, ts, notes))
            stats["interactions_created"] += 1
        else:
            # occurred_at is NOT NULL, so notes without a parseable date can't
            # insert — count the drop instead of losing it invisibly
            stats["skipped_undated_notes"] += 1


@router.get("/uploads")
def list_uploads():
    with db() as conn, conn.cursor() as cur:
        cur.execute("""SELECT upload_id, filename, row_count, status, created_at
                       FROM uploads ORDER BY created_at DESC LIMIT 50""")
        return {"uploads": rows(cur)}
