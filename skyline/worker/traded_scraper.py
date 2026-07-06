"""
traded_scraper.py — user-provided script, saved verbatim. See original docstring.
"""

from __future__ import annotations

import os
import re
import json
import sqlite3
import logging
import time
import random
from datetime import datetime, timezone
from typing import Dict, List, Optional
from urllib.parse import urljoin, urlparse

try:
    import requests
    from bs4 import BeautifulSoup
except ImportError:
    raise ImportError(
        "Install core dependencies: pip install requests beautifulsoup4 lxml"
    )

try:
    import instaloader  # type: ignore
    HAS_INSTALOADER = True
except ImportError:
    instaloader = None  # type: ignore
    HAS_INSTALOADER = False

try:
    import gspread  # type: ignore
    from oauth2client.service_account import ServiceAccountCredentials  # type: ignore
    HAS_GSPREAD = True
except ImportError:
    gspread = None  # type: ignore
    ServiceAccountCredentials = None  # type: ignore
    HAS_GSPREAD = False

# Optional: curl_cffi — real-Chrome TLS fingerprint. VERIFIED 2026-07-02:
# Cloudflare on traded.co blocks python-requests' TLS fingerprint (403 in 6/6
# header/session variants tested) while curl_cffi Chrome impersonation passed
# 2/2. Install with: pip install curl_cffi
try:
    from curl_cffi import requests as cffi_requests  # type: ignore
    HAS_CURL_CFFI = True
except ImportError:
    cffi_requests = None  # type: ignore
    HAS_CURL_CFFI = False

# Optional: ScraperAPI proxy (the transport this dataset's historical
# traded.co imports used, per record notes). Set SCRAPERAPI_KEY to enable.
SCRAPERAPI_KEY = os.environ.get("SCRAPERAPI_KEY", "")

try:
    from zoneinfo import ZoneInfo  # type: ignore
    EASTERN = ZoneInfo("America/New_York")
except ImportError:
    try:
        import pytz  # type: ignore
        EASTERN = pytz.timezone("America/New_York")
    except ImportError:
        from datetime import timedelta
        EASTERN = timezone(timedelta(hours=-5))

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger(__name__)

TRADED_BASE = "https://traded.co"
TRADED_NY_INDEX = "https://traded.co/deals/new-york/"
TRADED_BOROUGH_INDEXES = [
    "https://traded.co/deals/manhattan/",
    "https://traded.co/deals/brooklyn/",
    "https://traded.co/deals/queens/",
    "https://traded.co/deals/bronx/",
    "https://traded.co/deals/staten-island/",
]
# Per-asset NY sale listing pages (TRADED_SALE_URLS set from the verified
# autoScrapeListings / fetchTradedDeals / tradedScraper.js sources). These
# surface deals the borough indexes rotate out of view.
TRADED_ASSET_SALE_INDEXES = [
    "https://traded.co/deals/new-york/multifamily/sale/",
    "https://traded.co/deals/new-york/office/sale/",
    "https://traded.co/deals/new-york/retail/sale/",
    "https://traded.co/deals/new-york/industrial/sale/",
    "https://traded.co/deals/new-york/hotel/sale/",
    "https://traded.co/deals/new-york/mixed-use/sale/",
    "https://traded.co/deals/new-york/development/sale/",
]
TRADED_ALL_DEALS_INDEX = "https://traded.co/deals/"
# Sitemap index: exposes the FULL history of deal URLs (with <lastmod>), the
# path to every past deal that the recency-ordered listing pages don't reach.
TRADED_SITEMAP_INDEX = "https://traded.co/sitemap.xml"
INSTAGRAM_PROFILE = "tradedny"

REQUEST_DELAY = float(os.environ.get("TRADED_REQUEST_DELAY", "3"))
INSTALOADER_SLEEP = float(os.environ.get("INSTALOADER_SLEEP", "8"))

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "en-US,en;q=0.9",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
}

CAPTION_PATTERNS: Dict[str, re.Pattern] = {
    "sale_date":  re.compile(r"DATE\s*:\s*(.+)",                 re.IGNORECASE),
    "address":    re.compile(r"ADDRESS\s*:\s*(.+)",              re.IGNORECASE),
    "market":     re.compile(r"MARKET\s*:\s*(.+)",               re.IGNORECASE),
    "asset_type": re.compile(r"ASSET\s+TYPE\s*:\s*(.+)",         re.IGNORECASE),
    "buyer":      re.compile(r"BUYER\s*:\s*(.+)",                re.IGNORECASE),
    "seller":     re.compile(r"SELLER\s*:\s*(.+)",               re.IGNORECASE),
    "sale_price": re.compile(r"SALE\s+PRICE\s*:\s*\$?([\d,\.]+)", re.IGNORECASE),
    "units":      re.compile(r"UNITS\s*:\s*([\d,]+)",            re.IGNORECASE),
    "ppu":        re.compile(r"PPU\s*:\s*\$?([\d,\.]+)",         re.IGNORECASE),
    "square_feet":re.compile(r"\bSF\s*:\s*([\d,\.]+)",           re.IGNORECASE),
    "ppsf":       re.compile(r"\bPPSF\s*:\s*\$?([\d,\.]+)",      re.IGNORECASE),
    "landlord":   re.compile(r"LANDLORD\s*:\s*(.+)",             re.IGNORECASE),
    "tenant":     re.compile(r"TENANT\s*:\s*(.+)",               re.IGNORECASE),
    "lender":     re.compile(r"LENDER\s*:\s*(.+)",               re.IGNORECASE),
    "borrower":   re.compile(r"BORROWER\s*:\s*(.+)",             re.IGNORECASE),
    "transaction_type": re.compile(
        r"\b(SALE|LEASE|LOAN|SOLD|LEASED|FINANCED)\b",          re.IGNORECASE
    ),
}


def init_db(db_path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS deals (
            shortcode     TEXT,
            traded_url    TEXT,
            source_primary TEXT,
            source_secondary TEXT,
            caption       TEXT,
            post_date     TEXT,
            inserted_at   TEXT NOT NULL,
            sale_date     TEXT,
            address       TEXT,
            market        TEXT,
            asset_type    TEXT,
            transaction_type TEXT,
            buyer         TEXT,
            seller        TEXT,
            landlord      TEXT,
            tenant        TEXT,
            lender        TEXT,
            borrower      TEXT,
            sale_price    REAL,
            units         INTEGER,
            ppu           REAL,
            square_feet   REAL,
            ppsf          REAL,
            synced        INTEGER DEFAULT 0,
            UNIQUE (shortcode),
            UNIQUE (traded_url)
        )
        """
    )
    try:
        conn.execute("ALTER TABLE deals ADD COLUMN synced INTEGER DEFAULT 0")
    except sqlite3.OperationalError:
        pass
    conn.commit()
    return conn


def _already_stored(conn: sqlite3.Connection, shortcode: Optional[str], traded_url: Optional[str]) -> bool:
    cur = conn.cursor()
    if shortcode:
        cur.execute("SELECT 1 FROM deals WHERE shortcode = ?", (shortcode,))
        if cur.fetchone():
            return True
    if traded_url:
        cur.execute("SELECT 1 FROM deals WHERE traded_url = ?", (traded_url,))
        if cur.fetchone():
            return True
    return False


def insert_record(
    conn: sqlite3.Connection,
    *,
    shortcode: Optional[str],
    traded_url: Optional[str],
    source_primary: str,
    caption: str,
    post_date: Optional[str],
    parsed: Dict[str, Optional[str]],
) -> bool:
    if _already_stored(conn, shortcode, traded_url):
        return False

    def to_int(v: Optional[str]) -> Optional[int]:
        if v:
            cleaned = v.replace(",", "")
            return int(cleaned) if cleaned.isdigit() else None
        return None

    def to_float(v: Optional[str]) -> Optional[float]:
        if v:
            try:
                return float(v.replace(",", ""))
            except ValueError:
                return None
        return None

    conn.execute(
        """
        INSERT OR IGNORE INTO deals (
            shortcode, traded_url, source_primary, caption, post_date,
            inserted_at, sale_date, address, market, asset_type,
            transaction_type, buyer, seller, landlord, tenant, lender,
            borrower, sale_price, units, ppu, square_feet, ppsf
        ) VALUES (
            :shortcode, :traded_url, :source_primary, :caption, :post_date,
            :inserted_at, :sale_date, :address, :market, :asset_type,
            :transaction_type, :buyer, :seller, :landlord, :tenant, :lender,
            :borrower, :sale_price, :units, :ppu, :square_feet, :ppsf
        )
        """,
        {
            "shortcode":        shortcode,
            "traded_url":       traded_url,
            "source_primary":   source_primary,
            "caption":          caption,
            "post_date":        post_date,
            "inserted_at":      datetime.now(timezone.utc).isoformat(),
            "sale_date":        parsed.get("sale_date"),
            "address":          parsed.get("address"),
            "market":           parsed.get("market"),
            "asset_type":       parsed.get("asset_type"),
            "transaction_type": parsed.get("transaction_type"),
            "buyer":            parsed.get("buyer"),
            "seller":           parsed.get("seller"),
            "landlord":         parsed.get("landlord"),
            "tenant":           parsed.get("tenant"),
            "lender":           parsed.get("lender"),
            "borrower":         parsed.get("borrower"),
            "sale_price":       to_float(parsed.get("sale_price")),
            "units":            to_int(parsed.get("units")),
            "ppu":              to_float(parsed.get("ppu")),
            "square_feet":      to_float(parsed.get("square_feet")),
            "ppsf":             to_float(parsed.get("ppsf")),
        },
    )
    conn.commit()
    return conn.execute("SELECT changes()").fetchone()[0] > 0


def parse_caption(text: str) -> Dict[str, Optional[str]]:
    result: Dict[str, Optional[str]] = {k: None for k in CAPTION_PATTERNS}
    text = (
        text.replace("\u00a0", " ")
            .replace("\u2019", "'")
            .replace("\u2018", "'")
            .replace("\u201c", '"')
            .replace("\u201d", '"')
    )
    lines = [line.strip() for line in text.split("\n") if line.strip()]
    for line in lines:
        for key, pattern in CAPTION_PATTERNS.items():
            if result[key] is not None:
                continue
            m = pattern.search(line)
            if m:
                result[key] = m.group(1).strip()
    return result


def _get(url: str, session: requests.Session, retries: int = 4) -> Optional[requests.Response]:
    delay = REQUEST_DELAY
    for attempt in range(1, retries + 1):
        try:
            if SCRAPERAPI_KEY:
                r = session.get(
                    "https://api.scraperapi.com/",
                    params={"api_key": SCRAPERAPI_KEY, "url": url},
                    timeout=70,
                )
            elif HAS_CURL_CFFI:
                # Preferred direct transport: passes Cloudflare TLS fingerprinting.
                r = cffi_requests.get(url, impersonate="chrome", timeout=30)
            else:
                r = session.get(url, headers=HEADERS, timeout=20)
            if r.status_code == 200:
                return r
            if r.status_code in (403, 429, 503, 504):
                # 403 is retryable: Cloudflare blocks are transport/reputation
                # dependent, not permanent (verified: same URL flips 403->200).
                wait = delay * (2 ** attempt) + random.uniform(0, 1)
                log.warning("HTTP %d for %s – retrying in %.1fs", r.status_code, url, wait)
                time.sleep(wait)
            else:
                log.warning("HTTP %d for %s – skipping", r.status_code, url)
                return None
        except Exception as exc:
            # Broad catch is deliberate: curl_cffi raises non-requests exception
            # types. Every failure is logged and retried; final failure is
            # logged at ERROR below — nothing is silently suppressed.
            log.warning("Request error for %s: %s (attempt %d)", url, exc, attempt)
            time.sleep(delay * attempt)
    log.error("Giving up on %s after %d attempts", url, retries)
    return None


_DEAL_URL_RE = re.compile(
    r"https?://traded\.co/deals/[^/]+/[^/]+/(?:sale|lease|loan)/[^/\"'>]+/?",
    re.IGNORECASE,
)


def _extract_next_data_deal_urls(html: str) -> set:
    """Deal URLs from the page's __NEXT_DATA__ JSON: pageProps.initialDeals[].url
    plus a tree scan of any `url`/`link` string pointing at a deal page (the
    ${node.link} path in autoScrapeListings). Complements — never replaces —
    the raw-HTML regex/anchor scan."""
    urls: set = set()
    data = _extract_next_data(html)
    if not data:
        return urls

    def add(v):
        if isinstance(v, str):
            cand = urljoin(TRADED_BASE, v)
            if _DEAL_URL_RE.match(cand):
                urls.add(cand.rstrip("/") + "/")

    direct = (((data.get("props") or {}).get("pageProps")) or {}).get("initialDeals")
    if isinstance(direct, list):
        for d in direct:
            if isinstance(d, dict):
                add(d.get("url")); add(d.get("link"))

    def walk(o, depth):
        if depth > 10:
            return
        if isinstance(o, list):
            for v in o:
                walk(v, depth + 1)
        elif isinstance(o, dict):
            add(o.get("url")); add(o.get("link"))
            for v in o.values():
                walk(v, depth + 1)
    walk(data, 0)
    return urls


_SITEMAP_DEAL_RE = re.compile(
    r"<loc>(https://traded\.co/deals/new-york/[a-z-]+/sale/[^<]+)</loc>"
    r"(?:\s*<lastmod>([^<]+)</lastmod>)?",
    re.IGNORECASE,
)


def discover_sitemap_deal_urls(session: requests.Session) -> List[tuple]:
    """FULL-history discovery via the sitemap (port of the verified edge-function
    mechanism): sitemap.xml -> sub-sitemaps -> every sale deal URL with lastmod,
    returned newest-first so bounded runs pull the most recent deals first.
    One failed sub-sitemap never aborts discovery (failure is logged)."""
    resp = _get(TRADED_SITEMAP_INDEX, session)
    if not resp:
        log.error("sitemap index fetch failed")
        return []
    out, seen = [], set()
    subs = re.findall(r"<loc>([^<]+\.xml)</loc>", resp.text)
    for sub in subs:
        sub_resp = _get(sub, session)
        if not sub_resp:
            log.warning("sub-sitemap fetch failed: %s", sub)
            continue
        for m in _SITEMAP_DEAL_RE.finditer(sub_resp.text):
            u = m.group(1).rstrip("/") + "/"
            if u not in seen:
                seen.add(u)
                out.append((u, m.group(2) or ""))
        time.sleep(REQUEST_DELAY * 0.3 + random.uniform(0, 0.5))
    out.sort(key=lambda t: t[1], reverse=True)
    log.info("sitemap: %d deal URLs", len(out))
    return out


def discover_deal_urls(session: requests.Session, include_sitemap: bool = True) -> List[str]:
    seen: set[str] = set()
    discovery_pages = ([TRADED_NY_INDEX] + TRADED_BOROUGH_INDEXES
                       + TRADED_ASSET_SALE_INDEXES + [TRADED_ALL_DEALS_INDEX])

    for idx_url in discovery_pages:
        log.info("Discovering deals from %s", idx_url)
        resp = _get(idx_url, session)
        if not resp:
            continue

        soup = BeautifulSoup(resp.text, "lxml")
        for tag in soup.find_all("a", href=True):
            href = urljoin(TRADED_BASE, tag["href"])
            if _DEAL_URL_RE.match(href):
                clean = href.rstrip("/") + "/"
                seen.add(clean)

        for raw_url in _DEAL_URL_RE.findall(resp.text):
            seen.add(raw_url.rstrip("/") + "/")

        # __NEXT_DATA__ initialDeals[].url / node.link extraction (additive)
        seen |= _extract_next_data_deal_urls(resp.text)

        time.sleep(REQUEST_DELAY + random.uniform(0, 1))

    if include_sitemap:
        for u, _lastmod in discover_sitemap_deal_urls(session):
            seen.add(u)

    log.info("Discovered %d unique traded.co deal URLs", len(seen))
    return sorted(seen)


def _extract_text_block(soup: BeautifulSoup) -> str:
    for tag in soup(["script", "style", "noscript"]):
        tag.decompose()
    main = soup.find("main") or soup.find("article") or soup.find("body")
    return main.get_text(separator="\n") if main else soup.get_text(separator="\n")


def _extract_next_data(html: str) -> Optional[dict]:
    if not html:
        return None
    m = re.search(
        r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>',
        html, re.DOTALL,
    )
    if not m:
        return None
    try:
        return json.loads(m.group(1))
    except (ValueError, TypeError):
        return None


def _is_deal_like(o) -> bool:
    return (
        isinstance(o, dict)
        and ("salePrice" in o or "closingDate" in o)
        and isinstance(o.get("properties"), list)
    )


def _find_deal_nodes(data) -> List[dict]:
    pp = (((data or {}).get("props") or {}).get("pageProps")) or {}
    legacy = (((pp.get("initialValues") or {}).get("dealsWithCount") or {}).get("deals"))
    if isinstance(legacy, list) and legacy:
        nodes = [n for n in legacy if _is_deal_like(n)]
        if nodes:
            return nodes
    if _is_deal_like(pp.get("deal")):
        return [pp["deal"]]
    out: List[dict] = []
    seen = set()

    def walk(o, depth):
        if depth > 8 or not isinstance(o, (dict, list)):
            return
        if isinstance(o, list):
            for v in o:
                walk(v, depth + 1)
            return
        if _is_deal_like(o):
            if id(o) not in seen:
                seen.add(id(o))
                out.append(o)
            return
        for v in o.values():
            walk(v, depth + 1)

    walk(data, 0)
    return out


_TRADED_VERB_RE = re.compile(r"\b(acquires?|buys?|purchases?|sells?)\b", re.IGNORECASE)
_TRADED_TERM_RE = re.compile(r"\s+\b(?:for|in|at|with|represented)\b", re.IGNORECASE)


def _clean_party(raw) -> Optional[str]:
    if not raw:
        return None
    t = re.sub(r"\s+", " ", str(raw)).strip()
    t = re.sub(r"[\s,;:]+$", "", t).strip()
    return t or None


def _capture_after(keyword: str, text: str) -> Optional[str]:
    m = re.search(r"\b" + keyword + r"\s+(.+)$", text, re.IGNORECASE)
    if not m:
        return None
    val = m.group(1)
    term = _TRADED_TERM_RE.search(val)
    if term:
        val = val[: term.start()]
    return _clean_party(val)


def _parse_traded_title(title) -> tuple:
    if not title or not isinstance(title, str):
        return (None, None)
    verb = _TRADED_VERB_RE.search(title)
    if not verb:
        return (None, None)
    lead = _clean_party(title[: verb.start()])
    rest = title[verb.end():]
    if not lead:
        return (None, None)
    if re.match(r"(?i)^sells?$", verb.group(1)):
        return (_capture_after("to", rest), lead)
    return (lead, _capture_after("from", rest))


_ASSET_BY_SLUG = {
    "multifamily": "Multifamily", "office": "Office", "retail": "Retail",
    "industrial": "Industrial", "hotel": "Hotel", "mixed-use": "Mixed-Use",
    "development": "Development Site",
}


def _asset_from_url(url) -> Optional[str]:
    m = re.search(r"/(multifamily|office|retail|industrial|hotel|mixed-use|development)/",
                  str(url or ""), re.IGNORECASE)
    return _ASSET_BY_SLUG.get(m.group(1).lower()) if m else None


def _num_str(v) -> Optional[str]:
    try:
        n = float(v)
    except (TypeError, ValueError):
        return None
    if n != n or n <= 0:
        return None
    return str(int(n)) if n == int(n) else str(n)


def _party_name_from(deal, role) -> Optional[str]:
    """STRUCTURED buyer/seller from deal.buyers/sellers.profileDealCompanies|edges
    (port of the verified edge-function partyNameFrom). The prose-title parse
    remains the FALLBACK — kept, not retired."""
    grp = deal.get("buyers") if role == "buyer" else deal.get("sellers")
    if not isinstance(grp, dict):
        return None
    arr = grp.get("profileDealCompanies") or grp.get("edges")
    if not isinstance(arr, list) or not arr:
        return None
    hit = next((x for x in arr
                if (x.get("role") or (x.get("node") or {}).get("role")) == role), arr[0])
    p = hit.get("profile") or (hit.get("node") or {}).get("profile") or hit.get("node")
    if isinstance(p, dict) and p.get("name"):
        return str(p["name"]).strip()
    return None


def _parse_structured_deal(html: str, url: str) -> Optional[Dict[str, Optional[str]]]:
    data = _extract_next_data(html)
    if not data:
        return None
    nodes = _find_deal_nodes(data)
    if not nodes:
        return None
    node = nodes[0]
    props = node.get("properties")
    prop = props[0] if isinstance(props, list) and props else {}
    address = str(node.get("address") or prop.get("displayAddress") or prop.get("address") or "").strip()
    if not address:
        return None
    tb, ts = _parse_traded_title(node.get("title"))
    buyer = _party_name_from(node, "buyer") or tb
    seller = _party_name_from(node, "seller") or ts
    closing = node.get("closingDate")
    sale_date = closing[:10] if isinstance(closing, str) and len(closing) >= 10 else None

    parsed: Dict[str, Optional[str]] = {k: None for k in CAPTION_PATTERNS}
    parsed["address"] = address
    parsed["transaction_type"] = "SALE"
    parsed["asset_type"] = _asset_from_url(url)
    parsed["buyer"] = buyer
    parsed["seller"] = seller
    parsed["sale_price"] = _num_str(node.get("salePrice"))
    parsed["square_feet"] = _num_str(node.get("totalSquareFootageDeal"))
    parsed["sale_date"] = sale_date
    parsed["market"] = (prop.get("submarket") or prop.get("city") or None)
    return parsed


def scrape_traded_deal(url: str, session: requests.Session) -> Optional[Dict]:
    resp = _get(url, session)
    if not resp:
        return None

    soup = BeautifulSoup(resp.text, "lxml")

    post_date: Optional[str] = None
    time_tag = soup.find("time")
    if time_tag and time_tag.get("datetime"):
        post_date = time_tag["datetime"]
    if not post_date:
        post_date = datetime.now(timezone.utc).date().isoformat()

    structured = _parse_structured_deal(resp.text, url)
    if structured and structured.get("address"):
        return {
            "traded_url": url,
            "caption":    "",
            "post_date":  post_date,
            "parsed":     structured,
        }

    body_text = _extract_text_block(soup)
    parsed = parse_caption(body_text)

    return {
        "traded_url": url,
        "caption":    body_text[:4000],
        "post_date":  post_date,
        "parsed":     parsed,
    }


def scrape_traded(conn: sqlite3.Connection) -> List[Dict]:
    session = requests.Session()
    new_rows: List[Dict] = []

    deal_urls = discover_deal_urls(session)
    log.info("Processing %d traded.co deal URLs", len(deal_urls))

    for url in deal_urls:
        if _already_stored(conn, None, url):
            continue

        time.sleep(REQUEST_DELAY + random.uniform(0, 1))
        result = scrape_traded_deal(url, session)
        if not result:
            continue

        inserted = insert_record(
            conn,
            shortcode=None,
            traded_url=result["traded_url"],
            source_primary="traded.co",
            caption=result["caption"],
            post_date=result["post_date"],
            parsed=result["parsed"],
        )
        if inserted:
            row = {"traded_url": url, "post_date": result["post_date"], **result["parsed"]}
            new_rows.append(row)
            log.info("NEW (traded.co): %s", result["parsed"].get("address") or url)

    log.info("traded.co: %d new record(s)", len(new_rows))
    return new_rows


def run_once(conn: sqlite3.Connection, export_json: Optional[str] = None, traded_only: bool = False) -> None:
    log.info("─── Starting scrape cycle ───")
    new_rows: List[Dict] = []
    try:
        traded_rows = scrape_traded(conn)
        new_rows.extend(traded_rows)
    except Exception as exc:
        log.error("traded.co scrape failed: %s", exc)
    log.info("─── Cycle complete. %d new record(s) total. ───", len(new_rows))


def main(traded_only: bool = True) -> None:
    db_path = os.environ.get("TRADED_DB_PATH", "traded_deals.db")
    conn = init_db(db_path)
    log.info("Database: %s", os.path.abspath(db_path))
    run_once(conn, traded_only=traded_only)


if __name__ == "__main__":
    main()
