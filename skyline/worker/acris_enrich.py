"""
acris_enrich.py — Python port of the proven Base44 Deno ACRIS ingester mechanism.

Phase 1: fill missing buyer/seller (+ party mailing addresses) for rows that
         have a sale price, by matching amount -> ACRIS masters -> legals
         (address confirmation) -> parties.
Phase 2: same fill for rows WITHOUT a price, by per-row legals lookup
         (street number + canonical street name + borough) -> masters -> parties.
         When exactly one qualifying deed is found, the missing sale price is
         filled too.
Phase 3: fresh-deal ingest for the recent window (last 120 days), with the
         same PLUTO building-class filters as the Deno function. Deviation from
         the Deno code, per standing instruction: commercial condos (class R /
         ACRIS CC/CP) are EXCLUDED here, and C/D-class with <=4 units rejected
         as in the original.
"""
import re, json, time, sys, os
import pandas as pd
import requests
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
# shared/normalize.py is THE single implementation of these (its docstring says
# so); this module used to carry verbatim copies, which is the documented
# "one implementation" error class. Re-exported here because phase2/phase3/
# rolling/backfill import them from this module.
from shared.normalize import (PLACEHOLDER, is_placeholder, norm_entity,  # noqa: F401
                              DIR, SUF, canon_street, split_address)

ACRIS_BASE = "https://data.cityofnewyork.us/resource"
MASTER, LEGALS, PARTIES = "bnx9-e6tj", "8h5j-fqxa", "636b-3b5g"
PLUTO = "64uk-42ks"
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36"}
DEED_TYPES = "('DEED','DEEDO','DEEDP')"

BOROUGH_CODE = {"Manhattan": "1", "Bronx": "2", "Brooklyn": "3", "Queens": "4", "Staten Island": "5"}
CODE_BOROUGH = {v: k for k, v in BOROUGH_CODE.items()}

def soql(endpoint, params, retries=4):
    for attempt in range(retries):
        r = requests.get(f"{ACRIS_BASE}/{endpoint}.json", params=params, headers=UA, timeout=90)
        if r.status_code == 200:
            return r.json()
        if r.status_code in (429, 503):
            time.sleep(2 ** attempt)
            continue
        raise RuntimeError(f"{endpoint} HTTP {r.status_code}: {r.text[:200]}")
    raise RuntimeError(f"{endpoint}: retries exhausted")

def soql_all(endpoint, where, order, select=None, page=1000, cap=float("inf")):
    out, offset = [], 0
    while True:
        p = {"$where": where, "$order": order, "$limit": str(page)}
        if select:
            p["$select"] = select
        if offset:
            p["$offset"] = str(offset)
        rows = soql(endpoint, p)
        if not rows:
            break
        out.extend(rows)
        if len(rows) < page or len(out) >= cap:
            break
        offset += len(rows)
    return out

def chunked(seq, n):
    for i in range(0, len(seq), n):
        yield seq[i:i + n]

def fetch_parties(doc_ids):
    """doc_id -> {buyer, seller, buyer_address, seller_address} (first party of each type)."""
    parties = {}
    for chunk in chunked(sorted(doc_ids), 150):
        ids = ",".join(f"'{d}'" for d in chunk)
        # party_type/name in the ORDER keeps "first party of each type"
        # deterministic across runs when a deed lists several buyers
        rows = soql_all(PARTIES, f"document_id IN ({ids})", "document_id ASC, party_type ASC, name ASC")
        for r in rows:
            d = parties.setdefault(r["document_id"], {})
            addr = ", ".join(x for x in [r.get("address_1"), r.get("address_2"),
                                         r.get("city"), r.get("state"), r.get("zip")] if x)
            if r.get("party_type") == "1" and "seller" not in d:
                d["seller"], d["seller_address"] = r.get("name"), addr or None
            elif r.get("party_type") == "2" and "buyer" not in d:
                d["buyer"], d["buyer_address"] = r.get("name"), addr or None
    return parties

def fetch_legals(doc_ids):
    """doc_id -> first legals row (street number/name, borough, block, lot, property_type)."""
    legals = {}
    for chunk in chunked(sorted(doc_ids), 150):
        ids = ",".join(f"'{d}'" for d in chunk)
        rows = soql_all(LEGALS, f"document_id IN ({ids})", "document_id ASC")
        for r in rows:
            legals.setdefault(r["document_id"], r)
    return legals

def build_bbl(bc, block, lot):
    b = str(bc or "").strip()
    blk = re.sub(r"[^0-9]", "", str(block or ""))
    lt = re.sub(r"[^0-9]", "", str(lot or ""))
    if not re.match(r"^[1-5]$", b) or not blk or not lt or len(blk) > 5 or len(lt) > 4:
        return None
    return f"{b}{blk.zfill(5)}{lt.zfill(4)}"

def fetch_pluto(bbls):
    out = {}
    uniq = sorted({b for b in bbls if b})
    for chunk in chunked(uniq, 100):
        w = f"bbl in ({','.join(repr(b) for b in chunk)})"
        try:
            rows = soql(PLUTO, {"$select": "bbl,bldgclass,unitstotal,bldgarea,lotarea,yearbuilt",
                                "$where": w, "$limit": "5000"})
            for r in rows:
                out[str(int(float(r["bbl"])))] = r
        except Exception as e:
            print("pluto chunk failed:", e, file=sys.stderr)
    return out

# ── Phase 3 classification (port of the Deno logic; condo classes excluded) ──
ACRIS_RES_REJECT = {"D1","D2","D3","D4","RG","RP","RV","SC","SP","MC","MP","SA","SM","CK","CA","BS","TS","MR","GR","PS","NA","PA"}
DOF_REJECT = {"C0","C3","C6","C8","D0","D4","DC"}
CLASS_MAP = {"C": "Multifamily", "D": "Multifamily", "E": "Industrial", "F": "Industrial",
             "G": "Garage/Auto", "H": "Hotel", "J": "Entertainment", "K": "Retail",
             "L": "Office", "O": "Office", "P": "Entertainment", "S": "Mixed-Use",
             "V": "Development Site"}
CLASS_REJECT = set("ABIMNQTUWYZ") | {"R"}   # R (condos) rejected per standing instruction

def classify(bldgclass, acris_ptype, units):
    if bldgclass:
        two = bldgclass.upper()[:2]
        if two in DOF_REJECT:
            return None
        L = bldgclass[0].upper()
        if L in CLASS_REJECT:
            return None
        if L in "CD" and units is not None and units <= 4:
            return None
        if L in CLASS_MAP:
            return CLASS_MAP[L]
    pt = (acris_ptype or "").upper()
    if pt in ("CC", "CP"):        # commercial condo -> excluded per standing rule
        return None
    if pt in ACRIS_RES_REJECT and not (bldgclass and re.match(r"^[CDEFHKLO]", bldgclass, re.I)):
        return None
    return {"CR": "Commercial", "OF": "Office", "RB": "Retail", "IB": "Industrial",
            "AP": "Multifamily", "EA": "Entertainment", "D5": "Multifamily", "D6": "Multifamily",
            "F1": "Mixed-Use", "F4": "Mixed-Use", "F5": "Mixed-Use", "FS": "Mixed-Use",
            "VL": "Development Site", "VN": "Development Site", "VR": "Development Site",
            "SR": "Storage"}.get(pt, "Commercial" if pt else None)
