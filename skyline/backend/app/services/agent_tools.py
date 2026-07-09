"""agent_tools.py — SQL-first tool layer over the live sbi_* schema."""
import re
from ..db import db, rows

_TRGM_MIN = 0.45


def _resolve_entities(cur, name, limit=5):
    from shared.normalize import norm_entity
    nn = norm_entity(name)
    if not nn:
        return []
    cur.execute("SELECT entity_id, display_name FROM sbi_entities WHERE norm_name=%s", (nn,))
    r = cur.fetchall()
    if r:
        return [(x[0], x[1], "exact", 1.0) for x in r]
    cur.execute("""SELECT e.entity_id, e.display_name FROM sbi_entity_aliases a
                   JOIN sbi_entities e USING (entity_id) WHERE a.alias_norm=%s""", (nn,))
    r = cur.fetchall()
    if r:
        return [(x[0], x[1], "alias", 1.0) for x in r]
    cur.execute("""SELECT entity_id, display_name, similarity(norm_name,%s) AS s
                   FROM sbi_entities WHERE norm_name %% %s AND similarity(norm_name,%s) > %s
                   ORDER BY s DESC LIMIT %s""", (nn, nn, nn, _TRGM_MIN, limit))
    return [(x[0], x[1], "trgm", round(float(x[2]), 3)) for x in cur.fetchall()]


def lookup_contact(entity_name: str):
    with db() as conn, conn.cursor() as cur:
        matches = _resolve_entities(cur, entity_name)
        if not matches:
            return {"query": entity_name, "matches": [], "note": "No entity by that name."}
        out = []
        for eid, disp, method, score in matches:
            cur.execute("""SELECT person_name, title, phone, email, mailing_address, source, confidence
                           FROM sbi_contacts WHERE entity_id=%s ORDER BY is_primary DESC, confidence DESC""", (eid,))
            contacts = rows(cur)
            cur.execute("SELECT mailing_address FROM sbi_deal_parties WHERE entity_id=%s AND mailing_address IS NOT NULL LIMIT 1", (eid,))
            mail = cur.fetchone()
            out.append({"entity_id": str(eid), "name": disp, "match_method": method, "match_score": score,
                        "has_contact": bool(contacts), "contacts": contacts,
                        "mailing_address_from_deed": mail[0] if mail else None,
                        "note": None if contacts else
                        "No phone/email on file. Public records (ACRIS/PLUTO) cap at mailing addresses; "
                        "phone/email only exist where a source published them or a user uploaded them."})
        return {"query": entity_name, "matches": out}


def last_interaction(entity_name: str):
    with db() as conn, conn.cursor() as cur:
        matches = _resolve_entities(cur, entity_name)
        if not matches:
            return {"query": entity_name, "matches": []}
        out = []
        for eid, disp, method, score in matches:
            cur.execute("""SELECT channel, occurred_at, subject, notes, outcome, user_id
                           FROM sbi_interactions WHERE entity_id=%s ORDER BY occurred_at DESC LIMIT 5""", (eid,))
            inter = rows(cur)
            out.append({"entity_id": str(eid), "name": disp, "match_method": method,
                        "interaction_count": len(inter),
                        "last_interaction": inter[0] if inter else None, "recent": inter,
                        "note": None if inter else "No logged interactions for this entity."})
        return {"query": entity_name, "matches": out}


def buyer_leaderboard(asset_type=None, borough=None, price_min=None, price_max=None,
                      since=None, rank_by="count", limit=15):
    where, params = ["dp.role='buyer'"], []
    for col, val in (("d.asset_type", asset_type), ("p.borough", borough)):
        if val:
            where.append(f"{col}=%s")
            params.append(val)
    for col, val, op in (("d.sale_price", price_min, ">="), ("d.sale_price", price_max, "<="),
                         ("d.sale_date", since, ">=")):
        if val is not None:
            where.append(f"{col} {op} %s")
            params.append(val)
    order = "vol DESC" if rank_by == "vol" else "n DESC"
    with db() as conn, conn.cursor() as cur:
        cur.execute(f"""SELECT e.entity_id, e.display_name AS name, e.is_spv_suspect,
                          count(DISTINCT d.deal_id) AS n, coalesce(sum(d.sale_price),0) AS vol, max(d.sale_date) AS last_deal
                        FROM sbi_deal_parties dp JOIN sbi_entities e USING (entity_id)
                        JOIN sbi_deals d USING (deal_id) JOIN sbi_properties p USING (property_id)
                        WHERE {' AND '.join(where)}
                        GROUP BY e.entity_id, e.display_name, e.is_spv_suspect
                        ORDER BY {order} LIMIT %s""", params + [limit])
        return {"filters": {"asset_type": asset_type, "borough": borough, "price_min": price_min,
                            "price_max": price_max, "since": since, "rank_by": rank_by},
                "leaders": rows(cur)}


def find_similar_buyers(asset_type=None, borough=None, price=None, keywords=None, limit=15):
    kw = [k.strip().lower() for k in (keywords or []) if k and k.strip()]
    pmin = price * 0.5 if price else None
    pmax = price * 2.0 if price else None
    with db() as conn, conn.cursor() as cur:
        cur.execute("""
            WITH buyer_deals AS (
              SELECT e.entity_id, e.display_name, e.is_spv_suspect,
                     d.asset_type, p.borough, d.sale_price,
                     lower(coalesce(p.address_raw,'') || ' ' || coalesce(p.market,'')) AS hay
              FROM sbi_deal_parties dp JOIN sbi_entities e USING (entity_id)
              JOIN sbi_deals d USING (deal_id) JOIN sbi_properties p USING (property_id)
              WHERE dp.role='buyer'),
            scored AS (
              SELECT entity_id, display_name, is_spv_suspect, count(*) AS deal_count,
                     coalesce(sum(sale_price),0) AS volume,
                     sum(CASE WHEN %(asset)s IS NOT NULL AND asset_type=%(asset)s THEN 3
                              WHEN %(asset)s IS NOT NULL AND asset_type IS DISTINCT FROM %(asset)s THEN -2 ELSE 0 END) AS asset_pts,
                     sum(CASE WHEN %(boro)s IS NOT NULL AND borough=%(boro)s THEN 2
                              WHEN %(boro)s IS NOT NULL AND borough IS DISTINCT FROM %(boro)s THEN -1 ELSE 0 END) AS boro_pts,
                     sum(CASE WHEN %(pmin)s IS NOT NULL AND sale_price BETWEEN %(pmin)s AND %(pmax)s THEN 1
                              WHEN %(pmin)s IS NOT NULL AND sale_price IS NOT NULL THEN -1 ELSE 0 END) AS price_pts,
                     sum(CASE WHEN cardinality(%(kw)s::text[])>0 AND EXISTS (
                            SELECT 1 FROM unnest(%(kw)s::text[]) k WHERE hay LIKE '%%'||k||'%%') THEN 2 ELSE 0 END) AS kw_pts
              FROM buyer_deals GROUP BY entity_id, display_name, is_spv_suspect)
            SELECT entity_id, display_name AS name, deal_count, volume, is_spv_suspect,
                   (asset_pts + boro_pts + price_pts + kw_pts
                    + 0.5 * least(deal_count,5)
                    - CASE WHEN is_spv_suspect THEN 3 ELSE 0 END) AS score
            FROM scored
            ORDER BY score DESC, deal_count DESC LIMIT %(limit)s""",
            {"asset": asset_type, "boro": borough, "pmin": pmin, "pmax": pmax,
             "kw": kw, "limit": limit})
        cands = rows(cur)
        for c in cands:
            cur.execute("""SELECT d.sale_date, p.address_raw AS address, p.borough, d.asset_type, d.sale_price
                           FROM sbi_deal_parties dp JOIN sbi_deals d USING (deal_id) JOIN sbi_properties p USING (property_id)
                           WHERE dp.entity_id=%s AND dp.role='buyer'
                           ORDER BY d.sale_date DESC NULLS LAST LIMIT 3""", (c["entity_id"],))
            c["recent_deals"] = rows(cur)
            cur.execute("SELECT count(*) FROM sbi_contacts WHERE entity_id=%s", (c["entity_id"],))
            c["has_contact"] = cur.fetchone()[0] > 0
        return {"criteria": {"asset_type": asset_type, "borough": borough, "price": price, "keywords": kw},
                "candidates": cands}


def entity_history(entity_name: str, role=None):
    with db() as conn, conn.cursor() as cur:
        matches = _resolve_entities(cur, entity_name, limit=1)
        if not matches:
            return {"query": entity_name, "deals": []}
        eid, disp, method, score = matches[0]
        where = ["dp.entity_id=%s"]
        params = [eid]
        if role:
            where.append("dp.role=%s")
            params.append(role)
        cur.execute(f"""SELECT dp.role, d.sale_date, p.address_raw AS address, p.borough,
                          d.asset_type, d.sale_price, d.units, d.sqft, d.shortcode, d.source_url
                        FROM sbi_deal_parties dp JOIN sbi_deals d USING (deal_id) JOIN sbi_properties p USING (property_id)
                        WHERE {' AND '.join(where)} ORDER BY d.sale_date DESC NULLS LAST""", params)
        deal_rows = rows(cur)
        return {"entity_id": str(eid), "name": disp, "match_method": method,
                "deal_count": len(deal_rows), "deals": deal_rows}


def seller_owners_of_similar(asset_type=None, borough=None, limit=15):
    where, params = ["dp.role='seller'"], []
    for col, val in (("d.asset_type", asset_type), ("p.borough", borough)):
        if val:
            where.append(f"{col}=%s")
            params.append(val)
    with db() as conn, conn.cursor() as cur:
        cur.execute(f"""SELECT e.entity_id, e.display_name AS name, count(DISTINCT d.deal_id) AS sales,
                          coalesce(sum(d.sale_price),0) AS vol, max(d.sale_date) AS last_sale
                        FROM sbi_deal_parties dp JOIN sbi_entities e USING (entity_id)
                        JOIN sbi_deals d USING (deal_id) JOIN sbi_properties p USING (property_id)
                        WHERE {' AND '.join(where)}
                        GROUP BY e.entity_id, e.display_name ORDER BY sales DESC, vol DESC LIMIT %s""",
                    params + [limit])
        return {"filters": {"asset_type": asset_type, "borough": borough}, "sellers": rows(cur)}


def missing_contact_report(asset_type=None, borough=None, min_deals=2, limit=25):
    where, params = ["dp.role='buyer'"], []
    for col, val in (("d.asset_type", asset_type), ("p.borough", borough)):
        if val:
            where.append(f"{col}=%s")
            params.append(val)
    with db() as conn, conn.cursor() as cur:
        cur.execute(f"""SELECT e.entity_id, e.display_name AS name, count(DISTINCT d.deal_id) AS deals,
                          coalesce(sum(d.sale_price),0) AS vol
                        FROM sbi_deal_parties dp JOIN sbi_entities e USING (entity_id)
                        JOIN sbi_deals d USING (deal_id) JOIN sbi_properties p USING (property_id)
                        LEFT JOIN sbi_contacts c ON c.entity_id=e.entity_id
                        WHERE {' AND '.join(where)} AND c.contact_id IS NULL
                        GROUP BY e.entity_id, e.display_name
                        HAVING count(DISTINCT d.deal_id) >= %s ORDER BY vol DESC LIMIT %s""", params + [min_deals, limit])
        return {"filters": {"asset_type": asset_type, "borough": borough, "min_deals": min_deals},
                "entities_missing_contact": rows(cur)}


def recent_changes(days: int = 7, limit: int = 50):
    with db() as conn, conn.cursor() as cur:
        cur.execute("""SELECT d.deal_id, d.sale_date, p.address_raw AS address, p.borough,
                          d.asset_type, d.sale_price, d.source_system, d.created_at, d.updated_at
                        FROM sbi_deals d JOIN sbi_properties p USING (property_id)
                        WHERE d.created_at > now() - (%s || ' days')::interval
                           OR d.updated_at > now() - (%s || ' days')::interval
                        ORDER BY greatest(d.created_at, d.updated_at) DESC LIMIT %s""",
                    (days, days, limit))
        return {"days": days, "deals": rows(cur)}


_ALLOWED_TABLES = {"sbi_deals", "sbi_properties", "sbi_entities", "sbi_entity_aliases", "sbi_deal_parties",
                   "sbi_contacts", "sbi_interactions", "sbi_review_queue", "sbi_exclusion_ledger",
                   "sbi_fetch_ledger", "sbi_source_runs", "sbi_uploads", "sbi_upload_rows"}
_FORBIDDEN = re.compile(r"\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|"
                        r"copy|call|do|merge|vacuum|reindex|comment|set_config|pg_sleep|"
                        r"pg_read_file|pg_ls_dir|dblink|lo_import)\b", re.IGNORECASE)


def run_readonly_sql(sql: str, limit: int = 200):
    s = sql.strip().rstrip(";").strip()
    if not re.match(r"(?is)^\s*(select|with)\b", s):
        return {"error": "Only SELECT/WITH queries are permitted."}
    if ";" in s:
        return {"error": "Multiple statements are not permitted."}
    if '"' in s:
        return {"error": "Quoted identifiers are not permitted (use unquoted table names)."}
    if _FORBIDDEN.search(s):
        return {"error": "Query contains a forbidden keyword."}
    tables = set(re.findall(r"(?:from|join)\s+([a-zA-Z_][a-zA-Z0-9_.]*)", s, re.IGNORECASE))
    bad = {t for t in tables if t.split(".")[-1] not in _ALLOWED_TABLES or t.count(".") > 0}
    if bad:
        return {"error": f"Query references non-allowlisted table(s): {sorted(bad)}"}
    if not re.search(r"\blimit\s+\d+", s, re.IGNORECASE):
        s = f"{s} LIMIT {limit}"
    with db() as conn, conn.cursor() as cur:
        cur.execute("SET TRANSACTION READ ONLY")
        cur.execute("SET LOCAL statement_timeout = 5000")
        try:
            cur.execute(s)
            return {"sql": s, "rows": rows(cur)}
        except Exception as e:
            return {"error": f"Query failed: {str(e)[:300]}"}


TOOLS = {
    "lookup_contact": (lookup_contact, {"description": "Get phone/email/mailing address for an owner or company by name. Returns has_contact=false when nothing is on file.", "parameters": {"type": "object", "properties": {"entity_name": {"type": "string"}}, "required": ["entity_name"]}}),
    "last_interaction": (last_interaction, {"description": "When we last contacted an entity, and recent interaction history.", "parameters": {"type": "object", "properties": {"entity_name": {"type": "string"}}, "required": ["entity_name"]}}),
    "buyer_leaderboard": (buyer_leaderboard, {"description": "Top buyers by deal count or dollar volume, filterable by asset_type, borough, price range, and since-date.", "parameters": {"type": "object", "properties": {"asset_type": {"type": "string"}, "borough": {"type": "string"}, "price_min": {"type": "number"}, "price_max": {"type": "number"}, "since": {"type": "string"}, "rank_by": {"type": "string", "enum": ["count", "vol"]}}}}),
    "find_similar_buyers": (find_similar_buyers, {"description": "Best-fit buyers for a property profile, scored on real track record.", "parameters": {"type": "object", "properties": {"asset_type": {"type": "string"}, "borough": {"type": "string"}, "price": {"type": "number"}, "keywords": {"type": "array", "items": {"type": "string"}}}}}),
    "entity_history": (entity_history, {"description": "Full deal history for a buyer/seller by name.", "parameters": {"type": "object", "properties": {"entity_name": {"type": "string"}, "role": {"type": "string", "enum": ["buyer", "seller"]}}, "required": ["entity_name"]}}),
    "seller_owners_of_similar": (seller_owners_of_similar, {"description": "Sellers who have transacted a given asset type / borough.", "parameters": {"type": "object", "properties": {"asset_type": {"type": "string"}, "borough": {"type": "string"}}}}),
    "missing_contact_report": (missing_contact_report, {"description": "Active buyers with no phone/email on file.", "parameters": {"type": "object", "properties": {"asset_type": {"type": "string"}, "borough": {"type": "string"}, "min_deals": {"type": "integer"}}}}),
    "recent_changes": (recent_changes, {"description": "Deals added or updated in the last N days.", "parameters": {"type": "object", "properties": {"days": {"type": "integer"}}}}),
    "run_readonly_sql": (run_readonly_sql, {"description": "Escape hatch for long-tail questions. SELECT-only over sbi_* allowlisted tables.", "parameters": {"type": "object", "properties": {"sql": {"type": "string"}}, "required": ["sql"]}}),
}


def tool_specs():
    return [{"type": "function", "function": {"name": name, **spec}} for name, (_, spec) in TOOLS.items()]


def call_tool(name, arguments: dict):
    if name not in TOOLS:
        return {"error": f"unknown tool {name}"}
    fn, _ = TOOLS[name]
    try:
        return fn(**(arguments or {}))
    except TypeError as e:
        return {"error": f"bad arguments for {name}: {e}"}
