// traded-daily (Supabase-native rewrite, 2026-07-06): traded.co discovery via
// ScraperAPI -> Skyline Postgres via sync_upsert_deals(). Base44 removed.
// Secrets from app_config. body.maxFetches caps ScraperAPI spend per run.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const LISTINGS = [
  "https://traded.co/deals/new-york/multifamily/sale/", "https://traded.co/deals/new-york/office/sale/",
  "https://traded.co/deals/new-york/retail/sale/", "https://traded.co/deals/new-york/industrial/sale/",
  "https://traded.co/deals/new-york/hotel/sale/", "https://traded.co/deals/new-york/mixed-use/sale/",
  "https://traded.co/deals/new-york/development/sale/", "https://traded.co/deals/new-york/",
  "https://traded.co/deals/manhattan/", "https://traded.co/deals/brooklyn/",
  "https://traded.co/deals/queens/", "https://traded.co/deals/bronx/",
];
const SITEMAP_INDEX = "https://traded.co/sitemap.xml";
const DEADLINE_MS = 125_000;
const CONCURRENCY = 5;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let SCRAPERAPI_KEY = "";
async function scraperFetch(url: string): Promise<string> {
  const api = `https://api.scraperapi.com/?api_key=${SCRAPERAPI_KEY}&url=${encodeURIComponent(url)}&country_code=us`;
  const res = await fetch(api, { headers: { Accept: "text/html,*/*" } });
  if (!res.ok) throw new Error(`scraperapi ${res.status} for ${url}`);
  return await res.text();
}
async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = []; let i = 0;
  async function worker() { while (i < items.length) { const idx = i++; try { out[idx] = await fn(items[idx]); } catch { /* skip */ } } }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out.filter((x) => x !== undefined);
}
function parseNextData(html: string): any {
  if (!html || typeof html !== "string") return null;
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}
function normalizeTradedDealUrl(value: any): string | null {
  if (!value || typeof value !== "string") return null;
  const absolute = value.trim().startsWith("/") ? `https://traded.co${value.trim()}` : value.trim();
  try {
    const u = new URL(absolute);
    if (!/(^|\.)traded\.co$/i.test(u.hostname)) return null;
    if (!/^\/deals\/new-york\/[a-z-]+\/sale\/[^/]+\/?$/i.test(u.pathname)) return null;
    return `https://traded.co${u.pathname.replace(/\/+$/, "/")}`;
  } catch { return null; }
}
function extractListingDealUrls(html: string): string[] {
  const json = parseNextData(html);
  if (!json) return [];
  const urls = new Set<string>();
  const direct = json?.props?.pageProps?.initialDeals;
  if (Array.isArray(direct)) for (const d of direct) { const n = normalizeTradedDealUrl(d?.url); if (n) urls.add(n); }
  if (urls.size === 0) (function walk(o: any) {
    if (!o || typeof o !== "object") return;
    if (typeof o.url === "string" && /\/deals\/[a-z-]+\/[a-z-]+\/sale\//i.test(o.url)) { const n = normalizeTradedDealUrl(o.url); if (n) urls.add(n); }
    for (const k of Object.keys(o)) walk(o[k]);
  })(json);
  return [...urls];
}
async function discoverAllDealUrls(): Promise<string[]> {
  const urls = new Set<string>();
  const listingHtmls = await pool(LISTINGS, CONCURRENCY, scraperFetch);
  for (const html of listingHtmls) for (const u of extractListingDealUrls(html)) urls.add(u);
  try {
    const idx = await scraperFetch(SITEMAP_INDEX);
    const subs = [...idx.matchAll(/<loc>([^<]+\.xml)<\/loc>/g)].map((m) => m[1]);
    const subXmls = await pool(subs, CONCURRENCY, scraperFetch);
    for (const xml of subXmls) for (const m of xml.matchAll(/<loc>(https:\/\/traded\.co\/deals\/new-york\/[a-z-]+\/sale\/[^<]+)<\/loc>/g)) {
      const n = normalizeTradedDealUrl(m[1]); if (n) urls.add(n);
    }
  } catch { /* sitemap optional */ }
  return [...urls];
}
function isDealLike(o: any): boolean { return o && typeof o === "object" && !Array.isArray(o) && (o.salePrice !== undefined || o.closingDate !== undefined) && Array.isArray(o.properties); }
function findDealObject(root: any): any { let found: any = null; (function walk(o: any) { if (found || !o || typeof o !== "object") return; if (isDealLike(o)) { found = o; return; } for (const k of Object.keys(o)) walk(o[k]); })(root); return found; }
function pickField(o: any, keys: string[]): any { for (const k of keys) { if (o && o[k] != null && o[k] !== "") return o[k]; } return null; }
function partyNameFrom(deal: any, role: string): string | null {
  const grp = role === "buyer" ? deal.buyers : deal.sellers; const arr = grp && (grp.profileDealCompanies || grp.edges);
  if (Array.isArray(arr)) { const hit = arr.find((x: any) => (x.role || x.node?.role) === role) || arr[0]; const p = hit?.profile || hit?.node?.profile || hit?.node; if (p && p.name) return p.name; }
  return null;
}
const VERB_RE = /\b(acquires?|buys?|purchases?|sells?)\b/i;
const TERMINATOR = /\s+\b(?:for|in|at|with|represented)\b/i;
function cleanParty(raw: any): string | null { if (!raw) return null; const t = String(raw).replace(/\s+/g, " ").replace(/[\s,;:]+$/, "").trim(); return t || null; }
function captureAfter(keyword: string, text: string): string | null { const m = text.match(new RegExp(`\\b${keyword}\\s+(.+)$`, "i")); if (!m) return null; let v = m[1]; const t = v.match(TERMINATOR); if (t) v = v.slice(0, t.index); return cleanParty(v); }
function parseTradedTitle(title: string): { buyer: string | null; seller: string | null } {
  if (!title || typeof title !== "string") return { buyer: null, seller: null };
  const verb = title.match(VERB_RE); if (!verb) return { buyer: null, seller: null };
  const lead = cleanParty(title.slice(0, verb.index)); const rest = title.slice((verb.index as number) + verb[0].length); if (!lead) return { buyer: null, seller: null };
  if (/^sells?$/i.test(verb[1])) return { buyer: captureAfter("to", rest), seller: lead };
  return { buyer: lead, seller: captureAfter("from", rest) };
}
const ASSET_BY_SLUG: Record<string, string> = { multifamily: "Multifamily", office: "Office", retail: "Retail", industrial: "Industrial", hotel: "Hotel", "mixed-use": "Mixed-Use", development: "Development Site" };
function assetTypeFromUrl(url: string): string | null { const m = String(url || "").match(/\/(multifamily|office|retail|industrial|hotel|mixed-use|development)\//i); return m ? ASSET_BY_SLUG[m[1].toLowerCase()] : null; }
function zipBorough(zip: any): string | null { const z = String(zip || "").trim().match(/^\d{5}/); if (!z) return null; const n = parseInt(z[0], 10); if (n === 11004 || n === 11005) return "Queens"; const p = Math.floor(n / 100); if (p === 100 || p === 101 || p === 102) return "Manhattan"; if (p === 103) return "Staten Island"; if (p === 104) return "Bronx"; if (p === 112) return "Brooklyn"; if (p === 111 || p === 113 || p === 114 || p === 116) return "Queens"; return null; }
const BORO_RE: Array<[RegExp, string]> = [[/\bstaten island\b/i, "Staten Island"], [/\bbrooklyn\b/i, "Brooklyn"], [/\bqueens\b/i, "Queens"], [/\bbronx\b/i, "Bronx"], [/\bmanhattan\b/i, "Manhattan"]];
const NEIGH: Array<[string, string]> = [["yorkville", "Manhattan"], ["harlem", "Manhattan"], ["tribeca", "Manhattan"], ["soho", "Manhattan"], ["chelsea", "Manhattan"], ["midtown", "Manhattan"], ["upper east side", "Manhattan"], ["upper west side", "Manhattan"], ["inwood", "Manhattan"], ["hudson yards", "Manhattan"], ["williamsburg", "Brooklyn"], ["bushwick", "Brooklyn"], ["dumbo", "Brooklyn"], ["park slope", "Brooklyn"], ["bed-stuy", "Brooklyn"], ["bedford-stuyvesant", "Brooklyn"], ["sunset park", "Brooklyn"], ["astoria", "Queens"], ["long island city", "Queens"], ["flushing", "Queens"], ["jamaica", "Queens"], ["sunnyside", "Queens"], ["mott haven", "Bronx"], ["fordham", "Bronx"], ["riverdale", "Bronx"]];
function boroughFromText(text: string): string | null { const s = String(text || ""); for (const [re, b] of BORO_RE) if (re.test(s)) return b; const l = s.toLowerCase(); for (const [k, b] of NEIGH) if (l.includes(k)) return b; return null; }
function cleanSaleDate(v: any): string | null { if (v == null) return null; const s = String(v).trim(); if (!s) return null; if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10); const d = new Date(s); return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10); }
const SUFFIX_MAP: Record<string, string> = { STREET: "ST", ST: "ST", AVENUE: "AVE", AVE: "AVE", BOULEVARD: "BLVD", BLVD: "BLVD", ROAD: "RD", RD: "RD", DRIVE: "DR", DR: "DR", LANE: "LN", PLACE: "PL", PL: "PL", PARKWAY: "PKWY", SQUARE: "SQ", COURT: "CT", TERRACE: "TER" };
const DIR_MAP: Record<string, string> = { EAST: "E", WEST: "W", NORTH: "N", SOUTH: "S" };
function canonicalizeAddress(raw: string): string { if (!raw || typeof raw !== "string") return ""; let a = raw.trim().toUpperCase().replace(/[.,;:()]/g, " ").replace(/\s+(NY|NYC|NEW YORK|MANHATTAN|BROOKLYN|QUEENS|BRONX|STATEN ISLAND)$/g, "").replace(/\s+\d{5}(-\d{4})?$/, "").replace(/\s+/g, " ").trim(); if (!a) return ""; return a.split(" ").map((t) => DIR_MAP[t] || SUFFIX_MAP[t] || t).join(" ").trim(); }
function normalizeEntity(name: any): string | null { if (!name || typeof name !== "string") return null; const n = name.trim().toUpperCase().replace(/L\.L\.C\.|LLC/gi, "LLC").replace(/INC\.|INCORPORATED|INC/gi, "INC").replace(/\s+/g, " ").trim(); return n || null; }
function slugFromUrl(url: string): string { const seg = url.split("/").filter(Boolean).pop() || "deal"; return seg.toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-+|-+$/g, ""); }

function mapDealPage(deal: any, url: string): any {
  if (!deal) return null;
  const prop = (Array.isArray(deal.properties) && deal.properties[0]) || {};
  const address = String(pickField(prop, ["displayAddress", "address", "fullAddress", "name"]) || "").trim();
  if (!address) return null;
  const title = String(pickField(deal, ["title", "articleTitle", "caption"]) || "");
  const parsed = parseTradedTitle(title);
  const borough = zipBorough(prop.zip) || boroughFromText([prop.submarket, title, address].filter(Boolean).join(" "));
  const price = Number(pickField(deal, ["salePrice", "sale_price", "amount", "price"]) || 0);
  const sqft = Number(pickField(deal, ["totalSquareFootageDeal", "squareFeet", "square_feet"]) || 0);
  const saleDate = cleanSaleDate(pickField(deal, ["closingDate", "closing_date", "date", "publishedAt", "createdAt"]) || "");
  const buyer = partyNameFrom(deal, "buyer") || parsed.buyer;
  const seller = partyNameFrom(deal, "seller") || parsed.seller;
  let confidence = 20; if (price > 0) confidence += 25; if (buyer) confidence += 20; if (seller) confidence += 15; if (saleDate) confidence += 10;
  return {
    shortcode: `TRADED-${slugFromUrl(url)}`,
    address, address_norm: canonicalizeAddress(address),
    borough: borough || null, market: borough ? borough.toLowerCase() : null,
    asset_type: pickField(deal, ["assetType", "asset_type"]) || assetTypeFromUrl(url),
    sale_price: Number.isFinite(price) && price > 0 ? price : null,
    units: null, sqft: Number.isFinite(sqft) && sqft > 0 ? sqft : null,
    sale_date: saleDate, post_date: new Date().toISOString().slice(0, 10),
    source_system: "traded", source_url: url,
    confidence: Math.min(100, confidence),
    parse_status: confidence >= 60 ? "ok" : "needs_review",
    notes: `Auto-imported from traded.co via ScraperAPI. ${url}`, bbl: null,
    buyer: buyer || null, buyer_norm: normalizeEntity(buyer),
    seller: seller || null, seller_norm: normalizeEntity(seller),
    buyer_address: null, seller_address: null,
  };
}

async function existingTradedShortcodes(): Promise<Set<string>> {
  const seen = new Set<string>();
  for (let page = 0; page < 40; page++) {
    const { data, error } = await supa.from("deals").select("shortcode")
      .like("shortcode", "TRADED-%").range(page * 1000, page * 1000 + 999);
    if (error || !data || data.length === 0) break;
    for (const r of data) if (r.shortcode) seen.add(r.shortcode);
    if (data.length < 1000) break;
  }
  return seen;
}

async function run(body: any) {
  const start = Date.now();
  const overBudget = () => Date.now() - start > DEADLINE_MS;
  const maxFetches = Math.max(1, Math.min(70, Number(body.maxFetches) || 70));
  const allUrls = await discoverAllDealUrls();
  const existing = await existingTradedShortcodes();
  const allFresh = allUrls.filter((u) => !existing.has(`TRADED-${slugFromUrl(u)}`));
  const batch = allFresh.slice(0, maxFetches);

  const deals: any[] = [];
  await pool(batch, CONCURRENCY, async (u) => { if (overBudget()) return; const html = await scraperFetch(u); const deal = mapDealPage(findDealObject(parseNextData(html)), u); if (deal) deals.push(deal); });

  const totals: Record<string, number> = { inserted: 0, dup: 0, skipped_residential: 0, skipped_invalid: 0, parties: 0, contacts: 0, errors: 0 };
  const errSamples: string[] = [];
  if (deals.length) {
    const { data, error } = await supa.rpc("sync_upsert_deals", { rows: deals });
    if (error) { totals.errors += deals.length; errSamples.push("rpc: " + error.message); }
    else if (data) { for (const k of Object.keys(totals)) totals[k] += Number(data[k] ?? 0); for (const s of (data.error_samples ?? [])) if (errSamples.length < 5) errSamples.push(String(s)); }
  }

  const summary = { ok: true, ran_at: new Date().toISOString(), deal_urls_found: allUrls.length, already_in_db: existing.size, total_fresh: allFresh.length, batch: batch.length, parsed: deals.length, ...totals, fresh_remaining: Math.max(0, allFresh.length - batch.length), error_samples: errSamples, elapsed_ms: Date.now() - start };
  console.log("traded-daily summary:", JSON.stringify(summary));
  return summary;
}

Deno.serve(async (req: Request) => {
  const { data: cfg } = await supa.from("app_config").select("key,value").in("key", ["traded_secret", "scraperapi_key"]);
  const conf = Object.fromEntries((cfg ?? []).map((r) => [r.key, r.value]));
  if (req.headers.get("x-traded-secret") !== conf.traded_secret) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
  SCRAPERAPI_KEY = conf.scraperapi_key || "";
  try { const body = await req.json().catch(() => ({})); return new Response(JSON.stringify(await run(body)), { headers: { "Content-Type": "application/json" } }); }
  catch (e) { console.log("traded-daily fatal:", String(e)); return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500, headers: { "Content-Type": "application/json" } }); }
});
