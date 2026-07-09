"""entity_resolution.py — link uploaded owner/company names to sbi_entities.

Exact and alias matches auto-match. Fuzzy matches always go to review.
"""
import os
from shared.normalize import norm_entity, normalize_address

TRGM_THRESHOLD = float(os.environ.get("ENTITY_TRGM_THRESHOLD", "0.55"))


def resolve(cur, name, address=None):
    """Returns {status, entity_id?, method, candidates[]}.
    status in: auto_matched | needs_review | no_match. Never writes.
    """
    nn = norm_entity(name)
    if not nn:
        return {"status": "no_match", "method": None, "candidates": [], "reason": "unparseable name"}

    cur.execute("SELECT entity_id, display_name FROM sbi_entities WHERE norm_name=%s", (nn,))
    r = cur.fetchone()
    if r:
        return {"status": "auto_matched", "entity_id": str(r[0]), "display_name": r[1],
                "method": "exact", "candidates": []}

    cur.execute("""SELECT e.entity_id, e.display_name FROM sbi_entity_aliases a
                   JOIN sbi_entities e USING (entity_id) WHERE a.alias_norm=%s""", (nn,))
    r = cur.fetchone()
    if r:
        return {"status": "auto_matched", "entity_id": str(r[0]), "display_name": r[1],
                "method": "alias", "candidates": []}

    cur.execute("""SELECT entity_id, display_name, is_spv_suspect, similarity(norm_name,%s) AS s
                   FROM sbi_entities WHERE norm_name %% %s AND similarity(norm_name,%s) > %s
                   ORDER BY s DESC LIMIT 10""", (nn, nn, nn, TRGM_THRESHOLD))
    cands = [{"entity_id": str(x[0]), "display_name": x[1], "is_spv_suspect": x[2],
              "score": round(float(x[3]), 3), "reason": "trgm"} for x in cur.fetchall()]
    cands = [c for c in cands if not c["is_spv_suspect"]]

    if address:
        anorm = normalize_address(address)
        cur.execute("""SELECT DISTINCT e.entity_id, e.display_name, e.is_spv_suspect
                       FROM sbi_properties p JOIN sbi_deals d USING (property_id)
                       JOIN sbi_deal_parties dp USING (deal_id) JOIN sbi_entities e USING (entity_id)
                       WHERE p.address_norm=%s""", (anorm,))
        ctx = {str(x[0]): (x[1], x[2]) for x in cur.fetchall()}
        for c in cands:
            if c["entity_id"] in ctx:
                c["score"] += 1.0
                c["reason"] = "trgm+property_context"
        for eid, (disp, spv) in ctx.items():
            if eid not in {c["entity_id"] for c in cands}:
                cands.append({"entity_id": eid, "display_name": disp, "is_spv_suspect": bool(spv),
                              "score": 0.9, "reason": "property_context"})
        cands.sort(key=lambda c: c["score"], reverse=True)

    if cands:
        return {"status": "needs_review", "method": "trgm", "candidates": cands[:5]}
    return {"status": "no_match", "method": None, "candidates": []}
