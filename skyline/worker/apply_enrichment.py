"""apply_enrichment.py — the amount-gated ACRIS party fill, ported to Postgres.

PORT NOTE (2026-07-02): the amount-gate rule is UNCHANGED (|deed − price|/price ≤ 3%,
or no-price + deed within 60 days). The original read matches from a pickle and wrote
parties into a pandas frame; this version is the single Postgres write path:
store.apply_acris_party_fill enforces the gate in code, the acris_requires_gate DB
CHECK makes bypassing it impossible, and fills are never-overwrite with provenance.

The original standalone (matches.pkl -> frame) is preserved verbatim in
apply_enrichment.py.legacy. This module is imported by phase2_stages.run().
"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from acris_enrich import fetch_parties
from worker import store


def apply_fill(conn, deal_id, doc_id, deed_master, fetch_parties_fn=None):
    """Fetch the matched deed's parties and fill them through the amount gate.
    deed_master carries document_amt/document_date from the phase2 match.
    Returns the store result dict (status in: filled | gated_out | nothing_to_fill | no_such_deal)."""
    fetch_parties_fn = fetch_parties_fn or fetch_parties
    parties = (fetch_parties_fn([doc_id]) or {}).get(doc_id, {})
    amount = float(deed_master.get("document_amt") or 0)
    date = (deed_master.get("document_date") or "")[:10] or None
    return store.apply_acris_party_fill(
        conn, deal_id, doc_id, amount, date,
        buyer=parties.get("buyer"), seller=parties.get("seller"),
        buyer_address=parties.get("buyer_address"), seller_address=parties.get("seller_address"))
