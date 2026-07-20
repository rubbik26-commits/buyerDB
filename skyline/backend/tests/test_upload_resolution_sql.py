"""Database proof for the blueprint upload/entity-resolution workflow.

The test runs inside one transaction and rolls it back, so it proves exact matching,
fuzzy review, alias confirmation, phone/date normalization, and rematch dedupe without
leaving fixture rows behind.
fuzzy review, alias confirmation, phone/date normalization, rematch dedupe, and the
broker-facing upload audit history without leaving fixture rows behind.
"""
import json
import os
import uuid

import psycopg2
import pytest


def _one(cur, sql, params=()):
    cur.execute(sql, params)
    return cur.fetchone()[0]


def test_upload_resolution_requires_review_then_rematches_by_name_and_alias():
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    conn.autocommit = False
    cur = conn.cursor()
    cur.execute("select to_regprocedure('public.api_upload_stage(text,text,jsonb,jsonb,jsonb)')")
    if cur.fetchone()[0] is None:
        cur.close()
        conn.close()
        pytest.skip("SBI upload schema is prepared by the dedicated upload-resolution workflow")

    tag = uuid.uuid4().hex[:10].upper()
    exact_name = f"SKYLINE UPLOAD TEST HOLDINGS {tag}"
    fuzzy_name = f"SKYLINE UPLOD TEST HOLDINGS {tag}"
    mapping = {
        "Owner": "entity_name",
        "Contact": "person_name",
        "Phone": "phone",
        "Email": "email",
        "Last Contact": "last_contact_date",
        "Notes": "interaction_notes",
        "Channel": "channel",
        "Role": "role",
    }
    first_rows = [
        {
            "Owner": exact_name,
            "Contact": "Exact Test",
            "Phone": "(212) 555-0198",
            "Email": "EXACT.TEST@EXAMPLE.COM",
            "Last Contact": "2026-06-15",
            "Notes": f"exact-{tag}",
            "Channel": "call",
            "Role": "owner",
        },
        {
            "Owner": fuzzy_name,
            "Contact": "Fuzzy Test",
            "Phone": "646-555-0144",
            "Email": "fuzzy.test@example.com",
            "Last Contact": "2026-06-16",
            "Notes": f"fuzzy-{tag}",
            "Channel": "email",
            "Role": "owner",
        },
    ]

    try:
        staged = _one(
            cur,
            "select public.api_upload_stage(%s,%s,%s::jsonb,%s::jsonb,%s::jsonb)",
            (
                f"upload-resolution-{tag}.csv",
                "pytest",
                json.dumps(first_rows),
                json.dumps(list(first_rows[0].keys())),
                json.dumps(mapping),
            ),
        )
        upload_id = staged["upload_id"]
        resolved = _one(
            cur,
            "select public.api_upload_resolve(%s::uuid,%s::jsonb,%s)",
            (upload_id, json.dumps(mapping), "pytest"),
        )
        assert resolved["stats"]["new_entity"] == 1
        assert resolved["stats"]["needs_review"] == 1
        assert resolved["stats"]["contacts_created"] == 1
        assert resolved["stats"]["interactions_created"] == 1

        cur.execute(
            """
            select review_id,
                   payload->'candidates'->0->>'entity_id',
                   (payload->'candidates'->0->>'score')::numeric
            from public.sbi_review_queue
            where issue_class='entity_merge' and status='open'
              and object_id like %s
            """,
            (f"{upload_id}:%",),
        )
        review_id, entity_id, score = cur.fetchone()
        assert float(score) >= 0.55

        decision = _one(
            cur,
            "select public.api_review_act(%s::uuid,'confirm_merge',%s::uuid,'pytest')",
            (review_id, entity_id),
        )
        assert decision["status"] == "confirm_merge"

        cur.execute(
            "select status from public.sbi_uploads where upload_id=%s::uuid", (upload_id,)
        )
        assert cur.fetchone()[0] == "imported"
        cur.execute(
            "select count(*) from public.sbi_upload_rows where upload_id=%s::uuid and status='imported'",
            (upload_id,),
        )
        assert cur.fetchone()[0] == 2
        cur.execute(
            """
            select count(*) from public.sbi_contacts
            where source=%s and phone in ('+12125550198','+16465550144')
              and email in ('exact.test@example.com','fuzzy.test@example.com')
            """,
            (f"upload:{upload_id}",),
        )
        assert cur.fetchone()[0] == 2
        cur.execute(
            """
            select count(*) from public.sbi_interactions
            where notes in (%s,%s) and occurred_at::date in ('2026-06-15','2026-06-16')
            """,
            (f"exact-{tag}", f"fuzzy-{tag}"),
        )
        assert cur.fetchone()[0] == 2
        cur.execute(
            "select count(*) from public.sbi_entity_aliases where alias_raw=%s",
            (fuzzy_name,),
        )
        assert cur.fetchone()[0] == 1

        rematch_mapping = {
            "Owner": "entity_name",
            "Contact": "person_name",
            "Phone": "phone",
            "Email": "email",
        }
        rematch_rows = [
            {"Owner": exact_name, "Contact": "Exact Test", "Phone": "2125550198", "Email": "exact.test@example.com"},
            {"Owner": fuzzy_name, "Contact": "Fuzzy Test", "Phone": "6465550144", "Email": "fuzzy.test@example.com"},
        ]
        staged_again = _one(
            cur,
            "select public.api_upload_stage(%s,%s,%s::jsonb,%s::jsonb,%s::jsonb)",
            (
                f"upload-rematch-{tag}.csv",
                "pytest",
                json.dumps(rematch_rows),
                json.dumps(list(rematch_rows[0].keys())),
                json.dumps(rematch_mapping),
            ),
        )
        rematched = _one(
            cur,
            "select public.api_upload_resolve(%s::uuid,%s::jsonb,%s)",
            (staged_again["upload_id"], json.dumps(rematch_mapping), "pytest"),
        )
        assert rematched["stats"]["auto_matched"] == 1
        assert rematched["stats"]["alias_matched"] == 1
        assert rematched["stats"]["needs_review"] == 0
        assert rematched["stats"]["contacts_created"] == 0
        assert rematched["stats"]["contacts_updated"] == 2

        history = _one(cur, "select public.api_uploads_list()")
        first_history = next(item for item in history["uploads"] if item["upload_id"] == str(upload_id))
        assert first_history["status"] == "imported"
        assert first_history["row_count"] == 2
        assert first_history["staged_rows"] == 2
        assert first_history["imported_rows"] == 2
        assert first_history["needs_review_rows"] == 0
        assert first_history["open_review_items"] == 0
        assert first_history["rejected_rows"] == 0
        assert first_history["row_status_counts"] == {"imported": 2}
        assert first_history["column_mapping"]["Owner"] == "entity_name"
    finally:
        conn.rollback()
        cur.close()
        conn.close()
