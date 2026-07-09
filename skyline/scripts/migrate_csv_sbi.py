"""migrate_csv_sbi.py — load the canonical CSV into the live sbi_* schema.

Usage:
  DATABASE_URL=postgresql://... python scripts/migrate_csv_sbi.py NEW_YORK_CLOSED_ENRICHED_v8.csv [exclusions.csv]
  DATABASE_URL=postgresql://... python scripts/migrate_csv_sbi.py NEW_YORK_CLOSED_ENRICHED_v8.csv --reset

This loader writes only to sbi_* base tables. It is intended for the Supabase RPC
production mode where canonical names such as deals/properties/entities are views.
"""
import json
import os
import re
import sys

import pandas as pd
import psycopg2

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from shared.normalize import normalize_address, split_address, norm_entity, is_placeholder, spv_suspect, entity_type

DB = os.environ.get("DATABASE_URL")
ACRIS_DOC_RE = re.compile(r"doc_id=([A-Z0-9]+)")
PARTIES_ACRIS_RE = re.compile(r"parties from ACRIS (\w+) \(amount(?:-gated)?\)")


def src_system(url):
    u = str(url or "")
    if "a836-acris" in u:
        return "acris"
    if "traded.co" in u:
        return "traded"
    if "crexi" in u:
        return "crexi"
    if "instagram" in u:
        return "instagram"
    return "other"


def val(row, col, default=None):
    v = row.get(col, default)
    if pd.isna(v):
        return default
    return v


def as_int(v):
    if v is None or pd.isna(v) or v == "":
        return None
    try:
        return int(float(str(v).replace(",", "")))
    except Exception:
        return None


def as_float(v):
    if v is None or pd.isna(v) or v == "":
        return None
    try:
        return float(str(v).replace("$", "").replace(",", ""))
    except Exception:
        return None


def as_date(v):
    if v is None or pd.isna(v) or v == "":
        return None
    try:
        return pd.to_datetime(v).date().isoformat()
    except Exception:
        return None


def as_ts(v):
    if v is None or pd.isna(v) or v == "":
        return None
    try:
        return pd.to_datetime(v).isoformat()
    except Exception:
        return None


def reset_sbi(cur):
    cur.execute("""
        truncate table
          sbi_review_queue,
          sbi_contacts,
          sbi_deal_parties,
          sbi_deals,
          sbi_properties,
          sbi_entities
        restart identity cascade
    """)


def get_property_id(cur, row):
    address = str(val(row, "Address", "")).strip()
    borough = val(row, "Borough")
    market = val(row, "Market")
    number, street = split_address(address)
    cur.execute("""
        insert into sbi_properties(address_raw, street_number, street_name_canon, borough, market, source, provenance)
        values (%s,%s,%s,%s,%s,'csv',%s)
        on conflict (address_norm, borough)
        do update set address_raw=excluded.address_raw, street_number=excluded.street_number,
                      street_name_canon=excluded.street_name_canon, market=coalesce(excluded.market, sbi_properties.market), updated_at=now()
        returning property_id
    """, (address, number, street, borough, market, json.dumps({"loader": "migrate_csv_sbi"})))
    return cur.fetchone()[0]


def get_entity_id(cur, display_name, all_addr_norms):
    if not display_name or is_placeholder(str(display_name)):
        return None
    nn = norm_entity(display_name)
    if not nn:
        return None
    cur.execute("""
        insert into sbi_entities(display_name, entity_type, is_spv_suspect, provenance)
        values (%s,%s,%s,%s)
        on conflict (norm_name)
        do update set display_name=coalesce(sbi_entities.display_name, excluded.display_name), updated_at=now()
        returning entity_id
    """, (str(display_name).strip(), entity_type(nn), spv_suspect(nn, all_addr_norms), json.dumps({"loader": "migrate_csv_sbi"})))
    return cur.fetchone()[0]


def main(csv_path, exclusions_path=None, reset=False):
    if not DB:
        raise SystemExit("DATABASE_URL is required")
    df = pd.read_csv(csv_path, low_memory=False)
    conn = psycopg2.connect(DB)
    cur = conn.cursor()
    if reset:
        reset_sbi(cur)
    else:
        cur.execute("select count(*) from sbi_deals")
        existing = cur.fetchone()[0]
        if existing:
            conn.close()
            raise SystemExit(f"ABORT: sbi_deals already has {existing} rows. Use --reset only when you intentionally want to reload.")

    prop_ids = {}
    for _, row in df.iterrows():
        address = str(val(row, "Address", "")).strip()
        if not address:
            continue
        key = (normalize_address(address), val(row, "Borough"))
        if key not in prop_ids:
            prop_ids[key] = get_property_id(cur, row)

    all_addr_norms = {k[0] for k in prop_ids}
    ent_ids = {}
    def entity_id(name):
        nn = norm_entity(name)
        if not nn:
            return None
        if nn not in ent_ids:
            ent_ids[nn] = get_entity_id(cur, name, all_addr_norms)
        return ent_ids[nn]

    n_deals = n_parties = n_contacts = n_review = 0
    seen_docids, seen_shortcodes, seen_contacts = set(), set(), set()
    for i, row in df.iterrows():
        address = str(val(row, "Address", "")).strip()
        if not address:
            continue
        key = (normalize_address(address), val(row, "Borough"))
        property_id = prop_ids[key]
        source_url = val(row, "Source URL")
        source = src_system(source_url)
        notes = str(val(row, "Notes", "") or "")
        m = ACRIS_DOC_RE.search(str(source_url or ""))
        orig_doc_id = m.group(1) if m else None
        doc_id = orig_doc_id if orig_doc_id not in seen_docids else None
        shortcode = val(row, "Shortcode")
        if shortcode in seen_shortcodes:
            shortcode = f"{shortcode}-DUP{i}"
        sale_date = as_date(val(row, "sale_date_iso") or val(row, "Sale Date"))
        sale_price = as_float(val(row, "Sale Price"))
        cur.execute("""
            insert into sbi_deals(property_id, sale_date, post_date, asset_type, sale_price, units, sqft,
                                  source_system, source_url, source_urls, shortcode, acris_doc_id, confidence,
                                  parse_status, notes, source_key, provenance)
            values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
            on conflict (property_id, sale_price, sale_date)
            do update set updated_at=now()
            returning deal_id
        """, (property_id, sale_date, as_ts(val(row, "Post Date")), val(row, "Asset Type"), sale_price,
              as_int(val(row, "Units")), as_int(val(row, "Sq Ft")), source, source_url,
              [source_url] if source_url else None, shortcode, doc_id, as_int(val(row, "Confidence")),
              val(row, "Parse Status", "ok") or "ok", notes or None, shortcode or doc_id or source_url,
              json.dumps({"loader": "migrate_csv_sbi", "row": int(i)})))
        deal_id = cur.fetchone()[0]
        n_deals += 1
        if doc_id:
            seen_docids.add(doc_id)
        if shortcode:
            seen_shortcodes.add(shortcode)

        pm = PARTIES_ACRIS_RE.search(notes)
        if pm:
            party_src, prov, gate = "acris", pm.group(1), True
        elif source == "acris":
            party_src, prov, gate = "acris", orig_doc_id, True
        else:
            party_src, prov, gate = source, source_url, None
        for role, name_col, addr_col in (("buyer", "Buyer", "Buyer Address"), ("seller", "Seller", "Seller Address")):
            name = val(row, name_col)
            if not name or is_placeholder(str(name)):
                continue
            eid = entity_id(name)
            if not eid:
                continue
            cur.execute("""
                insert into sbi_deal_parties(deal_id, entity_id, role, mailing_address, source_system, provenance_ref, amount_gate_passed)
                values (%s,%s,%s,%s,%s,%s,%s)
                on conflict do nothing
            """, (deal_id, eid, role, val(row, addr_col), party_src, str(prov) if prov else None, gate))
            n_parties += cur.rowcount
            pre = "Buyer" if role == "buyer" else "Seller"
            phone = val(row, f"{pre} Phone")
            email = val(row, f"{pre} Email")
            website = val(row, f"{pre} Website")
            if phone or email or website:
                ckey = (eid, str(phone or "").strip(), str(email or "").strip(), str(website or "").strip())
                if ckey not in seen_contacts:
                    seen_contacts.add(ckey)
                    cur.execute("""
                        insert into sbi_contacts(entity_id, phone, email, website, mailing_address, source, provenance)
                        values (%s,%s,%s,%s,%s,'csv',%s)
                    """, (eid, phone, email, website, val(row, addr_col), json.dumps({"loader": "migrate_csv_sbi", "role": role})))
                    n_contacts += 1
        if (val(row, "Parse Status", "ok") or "ok") == "needs_review":
            cur.execute("""
                insert into sbi_review_queue(object_type, object_id, issue_class, payload)
                values ('deal', %s, 'legacy_needs_review', %s)
            """, (str(deal_id), json.dumps({"address": address, "notes": notes[:500]})))
            n_review += 1

    conn.commit()
    print(json.dumps({"deals": n_deals, "properties": len(prop_ids), "entities": len(ent_ids), "parties": n_parties, "contacts": n_contacts, "review": n_review}, default=str))
    conn.close()


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if a != "--reset"]
    if not args:
        raise SystemExit("Usage: python scripts/migrate_csv_sbi.py NEW_YORK_CLOSED_ENRICHED_v8.csv [exclusions.csv] [--reset]")
    main(args[0], args[1] if len(args) > 1 else None, reset="--reset" in sys.argv)
