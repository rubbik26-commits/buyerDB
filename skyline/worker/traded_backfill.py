"""
traded_backfill.py — full-history traded.co backfill, porting the PROVEN
mechanisms from the two verified Base44 edge functions (fetchTradedDeals and
the scheduled traded ingester):

  - sitemap + listing-page URL discovery (done upstream; this consumes backlog.pkl)
  - __NEXT_DATA__ structured parse; deal object located by SIGNATURE
  - STRUCTURED buyer/seller from deal.buyers/sellers.profileDealCompanies|edges
    (the prose-title parse is the FALLBACK, exactly as in the edge functions —
    this is why the title-only parse found almost no buyers)
  - geo resolution with doc-4's reliability ranking: a specific caption/submarket
    neighborhood OUTRANKS traded.co's frequently mis-geocoded ZIP; conflicts are
    FLAGGED (geo_conflict -> needs_review), never silently asserted
  - Cloudflare challenge detection (403/503/429 or challenge body w/o __NEXT_DATA__)
  - checkpointed, concurrency-bounded runner that advances across runs

Run:  python3 traded_backfill.py <batch_size>
Consumes backlog.pkl (list of (url, lastmod), newest first).
Appends parsed rows to backfill_rows.pkl; checkpoint in backfill_done.pkl.
"""
import sys, re, time, html as htmllib, pickle, os, random
from urllib.parse import quote
from concurrent.futures import ThreadPoolExecutor, as_completed

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from traded_scraper import (_extract_next_data, _find_deal_nodes,
                            _parse_traded_title, _clean_party,
                            _party_name_from as party_name_from,
                            CAPTION_PATTERNS)
from acris_enrich import is_placeholder

from curl_cffi import requests as cffi

D = os.path.dirname(os.path.abspath(__file__))
CONCURRENCY = 3

# ── Cloudflare challenge detection (port of doc-4 isCloudflareChallenge) ─────
CF_BODY = re.compile(r"Attention Required! \| Cloudflare|/cdn-cgi/challenge-platform|cf-mitigated|Just a moment\.\.\.", re.I)

def fetch_html(url):
    safe = quote(htmllib.unescape(url), safe=":/&?=%-,")
    r = cffi.get(safe, impersonate="chrome", timeout=30)
    if r.status_code in (403, 503, 429):
        raise RuntimeError(f"cloudflare_blocked HTTP {r.status_code}")
    if r.status_code != 200:
        raise RuntimeError(f"HTTP {r.status_code}")
    if CF_BODY.search(r.text) and "__NEXT_DATA__" not in r.text:
        raise RuntimeError("cloudflare_challenge_body")
    return r.text

# party_name_from is traded_scraper._party_name_from — this module used to carry
# a byte-for-byte copy, the documented "one implementation" error class.

def pick_field(o, keys):
    for k in keys:
        v = (o or {}).get(k)
        if v not in (None, ""):
            return v
    return None

# ── geography (port of doc-4 resolveTradedGeo, ranking + conflict flag) ──────
def zip_borough(z):
    m = re.match(r"^(\d{5})", str(z or "").strip())
    if not m:
        return None
    n = int(m.group(1))
    if n in (11004, 11005):
        return "Queens"
    p3 = n // 100
    return {100: "Manhattan", 101: "Manhattan", 102: "Manhattan", 103: "Staten Island",
            104: "Bronx", 112: "Brooklyn", 111: "Queens", 113: "Queens",
            114: "Queens", 116: "Queens"}.get(p3)

NEIGH = {"yorkville": "Manhattan", "harlem": "Manhattan", "tribeca": "Manhattan", "soho": "Manhattan",
         "nolita": "Manhattan", "chinatown": "Manhattan", "chelsea": "Manhattan", "midtown": "Manhattan",
         "upper east side": "Manhattan", "upper west side": "Manhattan", "inwood": "Manhattan",
         "hudson yards": "Manhattan", "east village": "Manhattan", "west village": "Manhattan",
         "greenwich village": "Manhattan", "financial district": "Manhattan", "lower east side": "Manhattan",
         "flatiron": "Manhattan", "williamsburg": "Brooklyn", "bushwick": "Brooklyn", "dumbo": "Brooklyn",
         "park slope": "Brooklyn", "bed-stuy": "Brooklyn", "bedford-stuyvesant": "Brooklyn",
         "sunset park": "Brooklyn", "brooklyn heights": "Brooklyn", "red hook": "Brooklyn",
         "bay ridge": "Brooklyn", "crown heights": "Brooklyn", "astoria": "Queens",
         "long island city": "Queens", "flushing": "Queens", "jamaica": "Queens", "sunnyside": "Queens",
         "forest hills": "Queens", "rego park": "Queens", "jackson heights": "Queens",
         "mott haven": "Bronx", "fordham": "Bronx", "riverdale": "Bronx", "wakefield": "Bronx"}
BOROS = ["Staten Island", "Brooklyn", "Queens", "Bronx", "Manhattan"]

def text_signal(text):
    s = str(text or "")
    lower = s.lower()
    explicit = next((b for b in BOROS if re.search(rf"\b{re.escape(b.lower())}\b", lower)), None)
    neigh = next(((k, b) for k, b in NEIGH.items() if k in lower), None)
    if explicit:
        return {"borough": explicit, "market": neigh[0] if neigh else None, "specific": True}
    if neigh:
        return {"borough": neigh[1], "market": neigh[0], "specific": True}
    return {"borough": None, "market": None, "specific": False}

def resolve_geo(zip_, city, submarket, title):
    t, sub = text_signal(title), text_signal(submarket)
    bz = zip_borough(zip_)
    city_b = next((b for b in BOROS if str(city or "").strip().lower() == b.lower()), None)
    signals = []
    if t["specific"]:
        signals.append(("caption", t["borough"]))
    if sub["specific"]:
        signals.append(("submarket", sub["borough"]))
    if bz:
        signals.append(("zip", bz))
    if city_b:
        signals.append(("city", city_b))
    borough, conflict, note = None, False, None
    if signals:
        borough = signals[0][1]
        distinct = {b for _, b in signals}
        if len(distinct) > 1:
            conflict = True
            dis = next(s for s in signals if s[1] != borough)
            note = f"Borough conflict: {signals[0][0]}={borough} vs {dis[0]}={dis[1]}; used {borough}"
    return borough, (t["market"] or sub["market"]), conflict, note

# ── dates (port of cleanSaleDate + caption recovery) ─────────────────────────
MONTHS = {m: i for i, m in enumerate(
    ["january", "february", "march", "april", "may", "june", "july", "august",
     "september", "october", "november", "december"], 1)}
MONTHS.update({m[:3]: i for m, i in list(MONTHS.items())}); MONTHS["sept"] = 9
PLACEHOLDER_DATE = re.compile(r"^(unknown|recent(ly closed)?|not specified|undisclosed|n/?a|tbd|none|null|pending|-+)$", re.I)

def clean_sale_date(v, title=""):
    s = str(v or "").strip()
    if s and not PLACEHOLDER_DATE.match(s):
        if re.match(r"^\d{4}-\d{2}-\d{2}", s):
            return s[:10]
        m = re.match(r"^(\d{1,2})/(\d{1,2})/(\d{4})$", s)
        if m:
            return f"{m.group(3)}-{int(m.group(1)):02d}-{int(m.group(2)):02d}"
    for pat, g in ((r"\b([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b", 3),
                   (r"\b([a-z]{3,9})\.?\s+(\d{4})\b", 2)):
        m = re.search(pat, str(title).lower())
        if m and m.group(1) in MONTHS:
            y = int(m.group(g)); mo = MONTHS[m.group(1)]
            d = int(m.group(2)) if g == 3 else 1
            return f"{y}-{mo:02d}-{d:02d}"
    return None

ASSET_BY_SLUG = {"multifamily": "Multifamily", "office": "Office", "retail": "Retail",
                 "industrial": "Industrial", "hotel": "Hotel", "mixed-use": "Mixed-Use",
                 "development": "Development Site", "development-site": "Development Site",
                 "land": "Development Site", "parking-lot": "Parking Lot", "garage": "Garage/Auto",
                 "commercial": "Commercial", "special-purpose": "Special Purpose",
                 "hospital": "Hospital", "nursing-home": "Nursing Home", "school": "School",
                 "church": "Church", "student-housing": "Student Housing",
                 "senior-housing": "Senior Housing", "package-deal": "Package Deal",
                 "storage": "Storage"}
RESIDENTIAL_REJECT = re.compile(r"co-?op|condo|single[\s-]?family|\bresidential\b", re.I)
HEADLINE_FRAGMENT = re.compile(r"\b(sells?|site|nearly|building)\b", re.I)

def clean_party_value(v):
    v = _clean_party(v)
    if not v or is_placeholder(v):
        return None
    if HEADLINE_FRAGMENT.search(v) and not re.search(r"\b(LLC|INC|LP|CORP|TRUST|GROUP|REALTY|CAPITAL|PARTNERS)\b", v, re.I):
        return None
    return v

def map_deal(html_text, url):
    data = _extract_next_data(html_text)
    if not data:
        return None, "no_next_data"
    nodes = _find_deal_nodes(data)
    if not nodes:
        return None, "no_deal_node"
    deal = nodes[0]
    props = deal.get("properties")
    prop = props[0] if isinstance(props, list) and props else {}
    address = str(pick_field(prop, ["displayAddress", "address", "fullAddress", "name"]) or "").strip()
    if not address:
        return None, "no_address"
    title = str(pick_field(deal, ["title", "articleTitle", "caption"]) or "")
    tb, ts = _parse_traded_title(title)
    buyer = clean_party_value(party_name_from(deal, "buyer") or tb)
    seller = clean_party_value(party_name_from(deal, "seller") or ts)
    borough, market, conflict, note = resolve_geo(prop.get("zip"), prop.get("city"),
                                                  prop.get("submarket"), title + " " + address)
    price = pick_field(deal, ["salePrice", "sale_price", "amount", "price"])
    try:
        price = float(price) if price is not None else None
    except (TypeError, ValueError):
        price = None
    if price is not None and price <= 0:
        price = None
    sqft = pick_field(deal, ["totalSquareFootageDeal", "squareFeet", "square_feet"])
    try:
        sqft = float(sqft) if sqft else None
    except (TypeError, ValueError):
        sqft = None
    slug_cat = re.search(r"/deals/[a-z-]+/([a-z-]+)/sale/", url, re.I)
    asset = pick_field(deal, ["assetType", "asset_type"]) or (ASSET_BY_SLUG.get(slug_cat.group(1).lower()) if slug_cat else None)
    ASSET_NORMALIZE = {"multifamily": "Multifamily", "mixed use": "Mixed-Use", "mixed-use": "Mixed-Use",
                       "development": "Development Site", "development site": "Development Site",
                       "garage": "Garage/Auto", "garage/auto": "Garage/Auto", "land": "Development Site"}
    if asset:
        asset = ASSET_NORMALIZE.get(str(asset).strip().lower(), str(asset).strip())
    if asset and RESIDENTIAL_REJECT.search(str(asset)):
        return None, f"residential_asset:{asset}"
    # Closing-date fields + caption recovery only. publishedAt/createdAt are
    # article timestamps — a deal written up months after closing would get a
    # fabricated sale date presented as fact.
    sale_date = clean_sale_date(pick_field(deal, ["closingDate", "closing_date", "date"]), title)
    units = pick_field(deal, ["totalUnitsDeal", "totalUnits", "units"])
    try:
        units = int(float(units)) if units else None
    except (TypeError, ValueError):
        units = None
    if units is None:
        m_units = CAPTION_PATTERNS["units"].search(title)
        if m_units:
            try:
                units = int(m_units.group(1).replace(",", ""))
            except ValueError:
                units = None
    if units is not None and units <= 0:
        units = None
    conf = 20 + (25 if price else 0) + (20 if buyer else 0) + (15 if seller else 0) + (10 if sale_date else 0)
    return {
        "Sale Date": sale_date, "sale_date_iso": sale_date, "Address": address,
        "Market": (market or (borough.lower() if borough else None)), "Borough": borough,
        "Asset Type": asset, "Buyer": buyer, "Seller": seller,
        "Sale Price": price, "Units": units, "Sq Ft": sqft,
        "PPSF": round(price / sqft) if price and sqft else None,
        "Source URL": url, "Shortcode": "TRADED-" + url.rstrip("/").split("/")[-1],
        "Confidence": min(100, conf),
        "Parse Status": "needs_review" if (conflict or conf < 60) else "ok",
        "Notes": ("parsed from traded.co deal page (curl_cffi transport)"
                  + (f" | {note}" if note else "")),
    }, "ok"


def run(batch_size):
    # STANDALONE-LEGACY path: pickle checkpoints predate the ledger-as-table
    # invariant and survive only for the one-off historical backfill runner.
    # The live daily path (run_incremental) imports fetch_html/map_deal only and
    # records every disposition in fetch_ledger.
    ordered = pickle.load(open(f"{D}/backlog.pkl", "rb"))
    done = pickle.load(open(f"{D}/backfill_done.pkl", "rb")) if os.path.exists(f"{D}/backfill_done.pkl") else {}
    rows = pickle.load(open(f"{D}/backfill_rows.pkl", "rb")) if os.path.exists(f"{D}/backfill_rows.pkl") else []
    todo = [(u, lm) for u, lm in ordered if u not in done][:batch_size]
    print(f"backlog {len(ordered)} | done {len(done)} | this batch {len(todo)}")

    def job(item):
        u, lm = item
        time.sleep(random.uniform(0.2, 0.8))
        try:
            row, status = map_deal(fetch_html(u), u)
        except Exception as e:
            return u, f"fetch_error:{e}", None
        return u, status, row

    with ThreadPoolExecutor(max_workers=CONCURRENCY) as ex:
        for i, f in enumerate(as_completed([ex.submit(job, t) for t in todo])):
            u, status, row = f.result()
            if status.startswith("fetch_error:"):
                # transient (Cloudflare/network): leave the URL in the backlog
                # so a later batch retries it instead of consuming it forever
                continue
            done[u] = status
            if row:
                rows.append(row)
            if i % 25 == 0:
                pickle.dump(done, open(f"{D}/backfill_done.pkl", "wb"))
                pickle.dump(rows, open(f"{D}/backfill_rows.pkl", "wb"))
                print(f"  {i}/{len(todo)}")
    pickle.dump(done, open(f"{D}/backfill_done.pkl", "wb"))
    pickle.dump(rows, open(f"{D}/backfill_rows.pkl", "wb"))
    from collections import Counter
    print("statuses:", dict(Counter(s.split(":")[0] for s in done.values())))
    print(f"rows collected so far: {len(rows)} | remaining: {len(ordered) - len(done)}")


if __name__ == "__main__":
    run(int(sys.argv[1]) if len(sys.argv) > 1 else 150)
