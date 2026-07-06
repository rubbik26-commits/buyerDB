"""migrate_csv.py — one-time migration: canonical CSV (v8) + ledger files -> Postgres.

Usage: python3 scripts/migrate_csv.py <dataset_v8.csv> [exclusion_additions.csv]
Env:   DATABASE_URL

Rules enforced here (same as the pipeline):
  * provenance parsed from Notes into deal_parties.source_system / provenance_ref;
    'parties from ACRIS <doc> (amount[-gated])' -> source_system='acris',
    amount_gate_passed=True (the phase-1/2 matchers only emitted amount-passing
    matches; apply_enrichment re-gated them — both paths satisfy the DB CHECK)
  * traded-published phones/emails land in contacts with source='traded'
  * needs_review rows are queued in review_queue
  * legacy Notes preserved verbatim on the deal row
"""
import os, re, sys, json
import pandas as pd
import psycopg2
import psycopg2.extras

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from shared.normalize import norm_entity, split_address, normalize_address, is_placeholder, spv_suspect

DB = os.environ.get("DATABASE_URL", "postgresql://skyline:skyline_dev@localhost/skyline")

ACRIS_DOC_RE = re.compile(r"doc_id=([A-Z0-9]+)")
PARTIES_ACRIS_RE = re.compile(r"parties from ACRIS (\w+) \(amount(?:-gated)?\)")


def src_system(url, notes):
    u = str(url or "")
    if "a836-acris" in u: return "acris"
    if "traded.co" in u:  return "traded"
    if "crexi" in u:      return "crexi"
    if "instagram" in u:  return "instagram"
    return "other"


def main(csv_path, exclusions_path=None):
    df = pd.read_csv(csv_path, low_memory=False)
    conn = psycopg2.connect(DB)
    cur = conn.cursor()

    # ── properties ──
    prop_ids = {}
    for _, r in df.iterrows():
        key = (normalize_address(r["Address"]), r["Borough"] if pd.notna(r["Borough"]) else None)
        if key in prop_ids:
            continue
        num, name = split_address(r["Address"])
        cur.execute(
            """INSERT INTO properties (address_raw, address_norm, street_number, street_name_canon, borough, market)
               VALUES (%s,%s,%s,%s,%s,%s)
               ON CONFLICT (address_norm, borough) DO UPDATE SET address_raw = properties.address_raw
               RETURNING property_id""",
            (r["Address"], key[0], num, name, key[1], r["Market"] if pd.notna(r["Market"]) else None))
        prop_ids[key] = cur.fetchone()[0]

    # ── entities ──
    ent_ids = {}
    all_addr_norms = set(k[0] for k in prop_ids)
    def entity_id(display):
        nn = norm_entity(display)
        if not nn:
            return None
        if nn in ent_ids:
            return ent_ids[nn]
        etype = "llc" if "LLC" in nn else ("corp" if re.search(r"\b(INC|CORP)\b", nn) else "unknown")
        cur.execute(
            """INSERT INTO entities (display_name, norm_name, entity_type, is_spv_suspect)
               VALUES (%s,%s,%s,%s) ON CONFLICT (norm_name) DO UPDATE SET norm_name=EXCLUDED.norm_name
               RETURNING entity_id""",
            (str(display).strip(), nn, etype, spv_suspect(nn, all_addr_norms)))
        ent_ids[nn] = cur.fetchone()[0]
        return ent_ids[nn]

    # ── deals + parties + contacts ──
    n_deals = n_parties = n_contacts = n_review = 0
    seen_docids, seen_shortcodes = set(), set()
    for i, r in df.iterrows():
        key = (normalize_address(r["Address"]), r["Borough"] if pd.notna(r["Borough"]) else None)
        notes = str(r["Notes"]) if pd.notna(r["Notes"]) else ""
        src = src_system(r["Source URL"], notes)
        m = ACRIS_DOC_RE.search(str(r["Source URL"] or ""))
        doc_id = m.group(1) if m else None
        if doc_id in seen_docids:
            doc_id = None                      # UNIQUE guard; duplicate doc under 2 rows -> keep 2nd row without doc key
        shortcode = r["Shortcode"] if pd.notna(r["Shortcode"]) else None
        if shortcode in seen_shortcodes:
            shortcode = f"{shortcode}-DUP{i}"
        cur.execute(
            """INSERT INTO deals (property_id, sale_date, post_date, asset_type, sale_price, units, sqft,
                                  source_system, source_url, shortcode, acris_doc_id, confidence, parse_status, notes)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING deal_id""",
            (prop_ids[key],
             r["sale_date_iso"] if pd.notna(r["sale_date_iso"]) else None,
             str(r["Post Date"])[:10] if pd.notna(r["Post Date"]) else None,
             r["Asset Type"] if pd.notna(r["Asset Type"]) else None,
             float(r["Sale Price"]) if pd.notna(r["Sale Price"]) else None,
             int(r["Units"]) if pd.notna(r["Units"]) else None,
             int(r["Sq Ft"]) if pd.notna(r["Sq Ft"]) else None,
             src, r["Source URL"] if pd.notna(r["Source URL"]) else None,
             shortcode, doc_id,
             int(r["Confidence"]) if pd.notna(r["Confidence"]) else None,
             r["Parse Status"] if pd.notna(r["Parse Status"]) else "ok",
             notes or None))
        deal_id = cur.fetchone()[0]
        n_deals += 1
        if doc_id: seen_docids.add(doc_id)
        if shortcode: seen_shortcodes.add(shortcode)

        pm = PARTIES_ACRIS_RE.search(notes)
        if pm:                       # cross-source ACRIS party attachment (amount-gated match)
            party_src, prov, gate = "acris", pm.group(1), True
        elif src == "acris":         # ACRIS-native deal: parties from the deed itself;
            party_src, prov, gate = "acris", doc_id, True   # price == document_amt by construction (phase3 build)
        else:
            party_src = src
            prov = r["Source URL"] if pd.notna(r["Source URL"]) else None
            gate = None
        for role, name_col, addr_col in (("buyer", "Buyer", "Buyer Address"), ("seller", "Seller", "Seller Address")):
            name = r[name_col]
            if pd.isna(name) or is_placeholder(str(name)):
                continue
            eid = entity_id(name)
            if not eid:
                continue
            cur.execute(
                """INSERT INTO deal_parties (deal_id, entity_id, role, mailing_address, source_system,
                                             provenance_ref, amount_gate_passed)
                   VALUES (%s,%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING""",
                (deal_id, eid, role,
                 r[addr_col] if pd.notna(r[addr_col]) else None,
                 party_src, str(prov) if prov else None, gate))
            n_parties += cur.rowcount
            # traded-published contact info -> contacts
            pre = "Buyer" if role == "buyer" else "Seller"
            phone = r.get(f"{pre} Phone"); email = r.get(f"{pre} Email")
            if (pd.notna(phone) and str(phone).strip()) or (pd.notna(email) and str(email).strip()):
                cur.execute(
                    """INSERT INTO contacts (entity_id, phone, email, mailing_address, source)
                       VALUES (%s,%s,%s,%s,%s)""",
                    (eid, str(phone).strip() if pd.notna(phone) else None,
                     str(email).strip() if pd.notna(email) else None,
                     r[addr_col] if pd.notna(r[addr_col]) else None, "traded"))
                n_contacts += 1

        if r["Parse Status"] == "needs_review":
            cur.execute(
                """INSERT INTO review_queue (object_type, object_id, issue_class, payload)
                   VALUES ('deal', %s, 'legacy_needs_review', %s)""",
                (str(deal_id), json.dumps({"address": r["Address"], "notes": notes[:500]})))
            n_review += 1

    # ── exclusion ledger seed ──
    n_excl = 0
    if exclusions_path and os.path.exists(exclusions_path):
        led = pd.read_csv(exclusions_path)
        for _, l in led.iterrows():
            cur.execute(
                """INSERT INTO exclusion_ledger (addr_norm, price, reason, evidence)
                   VALUES (%s,%s,%s,%s) ON CONFLICT DO NOTHING""",
                (l["addr_norm"], int(l["price"]) if pd.notna(l["price"]) else 0,
                 l["reason"], l["evidence"]))
            n_excl += cur.rowcount

    conn.commit()
    print(f"MIGRATED deals={n_deals} properties={len(prop_ids)} entities={len(ent_ids)} "
          f"parties={n_parties} contacts={n_contacts} review={n_review} exclusions={n_excl}")
    conn.close()


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else None)
