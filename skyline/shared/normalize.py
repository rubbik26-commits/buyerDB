"""shared/normalize.py — THE single implementation of the normalization invariants.

Extracted verbatim from the proven pipeline (acris_enrich.py + phase3_fresh.py build
stage). Backend, worker, and migration scripts all import from here so the exact
functions that were debugged the hard way (34/34 wrong-party audit; O'Callahan quote
bug; ordinal/direction canonicalization) exist in exactly one place.
"""
import re

PLACEHOLDER = re.compile(
    r"^(unknown|n/?a|not\s+specified|not\s+provided|not\s+disclosed|not\s+found|undisclosed|"
    r"confidential|withheld|anonymous|private\s+investor|various|multiple|null|undefined|none|"
    r"no\s+name|tbd|tba|-+|\*+)$", re.IGNORECASE)


def is_placeholder(v):
    if v is None or not isinstance(v, str) or not v.strip():
        return True
    return bool(PLACEHOLDER.match(v.strip()))


def norm_entity(name):
    if not name or is_placeholder(name):
        return None
    n = str(name).strip().upper()
    n = re.sub(r"L\.L\.C\.|LLC", "LLC", n)
    n = re.sub(r"INC\.|INCORPORATED|INC", "INC", n)
    return re.sub(r"\s+", " ", n).strip() or None


ENTITY_TYPE_LLC = re.compile(r"\bLLC\b")
ENTITY_TYPE_CORP = re.compile(r"\b(INC|CORP|CORPORATION)\b")


def entity_type(norm_name):
    """Classify a normalized entity name. Word-boundary matching: a substring
    check classified LINCOLN/PRINCETON/VINCENT names as corporations."""
    if not norm_name:
        return "unknown"
    if ENTITY_TYPE_LLC.search(norm_name):
        return "llc"
    if ENTITY_TYPE_CORP.search(norm_name):
        return "corp"
    return "unknown"


DIR = {"EAST": "E", "WEST": "W", "NORTH": "N", "SOUTH": "S"}
SUF = {"STREET": "ST", "ST": "ST", "AVENUE": "AVE", "AVE": "AVE", "AV": "AVE",
       "BOULEVARD": "BLVD", "BLVD": "BLVD", "ROAD": "RD", "RD": "RD", "DRIVE": "DR", "DR": "DR",
       "LANE": "LN", "LN": "LN", "PLACE": "PL", "PL": "PL", "PARKWAY": "PKWY", "PKWY": "PKWY",
       "SQUARE": "SQ", "COURT": "CT", "CT": "CT", "TERRACE": "TER", "TER": "TER",
       "PLAZA": "PLZ", "HIGHWAY": "HWY", "EXPRESSWAY": "EXPY", "BROADWAY": "BWAY"}


def canon_street(name):
    s = str(name or "").upper()
    s = re.sub(r"[.,#]", " ", s)
    s = re.sub(r"(\d+)(ST|ND|RD|TH)\b", r"\1", s)
    toks = [DIR.get(t, SUF.get(t, t)) for t in s.split()]
    return " ".join(t for t in toks if t)


def split_address(addr):
    m = re.match(r"^\s*(\d+[\-/]?\d*)\s+(.+)$", str(addr or ""))
    if not m:
        return None, None
    num = m.group(1).lstrip("0") or m.group(1)
    tail = re.sub(r",.*$", "", m.group(2))
    tail = re.sub(r"\b(NEW YORK|NY|NYC|MANHATTAN|BROOKLYN|QUEENS|BRONX|STATEN ISLAND)\b.*$", "",
                  tail, flags=re.IGNORECASE)
    return num, canon_street(tail)


def normalize_address(a):
    """Whole-address dedupe key (port of the phase3 build-stage normalizer)."""
    s = str(a).lower()
    s = re.sub(r"[.,#]", " ", s)
    s = re.sub(r"\b(new york|ny|brooklyn|bronx|queens|manhattan|staten island)\b", "", s)
    for k, v in {"east": "e", "west": "w", "north": "n", "south": "s", "street": "st",
                 "avenue": "ave", "boulevard": "blvd", "road": "rd", "place": "pl",
                 "parkway": "pkwy", "drive": "dr", "lane": "ln", "court": "ct",
                 "terrace": "ter", "square": "sq"}.items():
        s = re.sub(rf"\b{k}\b", v, s)
    s = re.sub(r"(\d+)(st|nd|rd|th)\b", r"\1", s)
    return re.sub(r"\s+", " ", s).strip()


BANNED_ASSET_TYPES = {"Condo", "Commercial Condo", "Co-op", "Single Family",
                      "Two Family", "1-2 Family"}

# DOF building classes that mean 1-2 family DWELLING (user rule 2026-07-02) or
# residential condo — a merge must reject or flag any candidate carrying these.
# NOTE: S1/S2 (store + 1-2 family) are deliberately NOT here: they are mixed-use
# commercial and the dataset keeps them (265 rows verified 2026-07-02).
ONE_TWO_FAMILY_CLASSES = re.compile(r"^(A[0-9A-Z]?|B[0-9A-Z]?|RG)$")
CONDO_BUILDING_CLASSES = re.compile(r"^R[0-9A-Z]?$")


def spv_suspect(norm_name, address_norms):
    """True if an entity name embeds a street number+token matching a known property
    address — the single-purpose-LLC pattern the Agent Desk discounts."""
    if not norm_name:
        return False
    m = re.match(r"^(\d+)[\s\-]+([A-Z0-9]+)", norm_name)
    if not m:
        return False
    key = f"{m.group(1)} {m.group(2).lower()}"
    return any(a.startswith(key.lower()) for a in address_norms)
