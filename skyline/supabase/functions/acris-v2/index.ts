// acris-v2 (Supabase-native rewrite, 2026-07-06): ACRIS deed window -> Skyline
// Postgres via sync_upsert_deals() RPC. Base44 removed. Secrets from app_config.
// v2.1: shared plumbing (_shared/mod.ts), fail-closed auth, deadline checks in
// the fetch/upsert phases, window-date validation, degradation counters.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {
  authorized, canonicalizeAddress, isPlaceholderOwner, json, loadConfig, newTotals,
  normalizeEntity, serviceClient, upsertDeals,
} from "../_shared/mod.ts";

const supa = serviceClient();
const ACRIS_BASE = "https://data.cityofnewyork.us/resource";
const PLUTO_DATASET = "64uk-42ks";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36";
const ACRIS_IN_CHUNK = 200;
const PLUTO_IN_CHUNK = 100;
const PRICE_FLOOR = 1_000_000;
const MASTER_CAP = 4000;
const DEADLINE_MS = 150_000;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

const BOROUGH_MAP: Record<string, string> = { "1": "Manhattan", "2": "Bronx", "3": "Brooklyn", "4": "Queens", "5": "Staten Island" };
const ACRIS_RESIDENTIAL_REJECT = new Set(["D1","D2","D3","D4","RG","RP","RV","SC","SP","MC","MP","SA","SM","CK","CA","BS","TS","MR","GR","PS","NA","PA"]);
const ACRIS_COMMERCIAL_CONDO = new Set(["CC","CP"]);
const DOF_REJECT_CODES = new Set(["C0","C3","C6","C8","D0","D4","DC"]);

const BAD_ADDRESS_PATTERN = /\b(portfolio|lease|leased|mortgage|loan|refi|refinance|financing|assignment|ucc)\b/i;
function isBadAddress(a: string): boolean { if(!a)return true; const t=String(a).trim(); if(!t)return true; if(BAD_ADDRESS_PATTERN.test(t))return true; if(!/^\d+\s+/.test(t))return true; return false; }
function buildBbl(bc: string, block: string, lot: string): string { const b=String(bc??"").trim(); const blk=String(block??"").replace(/[^0-9]/g,""); const lt=String(lot??"").replace(/[^0-9]/g,""); if(!/^[1-5]$/.test(b)||!blk||!lt)return""; if(blk.length>5||lt.length>4)return""; return`${b}${blk.padStart(5,"0")}${lt.padStart(4,"0")}`; }
const acrisSourceUrl = (doc: string) => `https://a836-acris.nyc.gov/DS/DocumentSearch/DocumentDetail?doc_id=${doc}`;

function classifyByBldgClass(bc: string | null, acrisPType: string | null): { assetType: string | null; reject: boolean } {
  if (!bc) return { assetType: null, reject: false };
  if (DOF_REJECT_CODES.has(bc.toUpperCase().slice(0, 2))) return { assetType: null, reject: true };
  const L = bc[0].toUpperCase();
  switch (L) {
    case "A": case "B": return { assetType: null, reject: true };
    case "C": case "D": return { assetType: "Multifamily", reject: false };
    case "E": case "F": return { assetType: "Industrial", reject: false };
    case "G": return { assetType: "Garage/Auto", reject: false };
    case "H": return { assetType: "Hotel", reject: false };
    case "I": case "M": case "N": case "Q": case "T": case "U": case "W": case "Y": case "Z": return { assetType: null, reject: true };
    case "J": case "P": return { assetType: "Entertainment", reject: false };
    case "K": return { assetType: "Retail", reject: false };
    case "L": case "O": return { assetType: "Office", reject: false };
    case "R": {
      if (acrisPType && ACRIS_COMMERCIAL_CONDO.has(acrisPType)) return { assetType: "Commercial Condo", reject: false };
      return { assetType: null, reject: true };
    }
    case "S": return { assetType: "Mixed-Use", reject: false };
    case "V": return { assetType: "Development", reject: false };
    default: return { assetType: null, reject: false };
  }
}
function classifyByAcris(pt: string | null): string | null {
  if (!pt) return null;
  const t = pt.toUpperCase();
  if (t === "CR") return "Commercial";
  if (t === "OF") return "Office";
  if (t === "RB") return "Retail";
  if (t === "IB") return "Industrial";
  if (t === "AP" || t === "D5" || t === "D6") return "Multifamily";
  if (t === "EA") return "Entertainment";
  if (t === "CC" || t === "CP") return "Commercial Condo";
  if (t === "F1" || t === "F4" || t === "F5" || t === "FS") return "Mixed-Use";
  if (t === "VL" || t === "VN" || t === "VR") return "Development";
  if (t === "SR") return "Storage";
  return "Commercial";
}

async function soqlFetch(base: string, endpoint: string, params: URLSearchParams): Promise<any[]> {
  const res = await fetch(`${base}/${endpoint}.json?${params}`, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`${endpoint} ${res.status}`); return await res.json();
}
async function soqlFetchAll(endpoint: string, where: string, orderBy: string, pageSize = 1000, cap = Infinity): Promise<any[]> {
  const all: any[] = []; let offset = 0;
  for (;;) { const p = new URLSearchParams({ $where: where, $order: orderBy, $limit: String(pageSize) }); if (offset) p.set("$offset", String(offset));
    const rows = await soqlFetch(ACRIS_BASE, endpoint, p); if (!Array.isArray(rows) || rows.length === 0) break; all.push(...rows); if (rows.length < pageSize || all.length >= cap) break; offset += rows.length; }
  return all;
}
async function fetchPlutoForBbls(bbls: string[], onChunkFail: () => void): Promise<Record<string, any>> {
  const out: Record<string, any> = {};
  const uniq = [...new Set(bbls.filter(Boolean))];
  for (let i = 0; i < uniq.length; i += PLUTO_IN_CHUNK) {
    const chunk = uniq.slice(i, i + PLUTO_IN_CHUNK);
    const inClause = chunk.map((b) => `'${b}'`).join(",");
    const p = new URLSearchParams({ $select: "bbl,bldgclass,landuse,unitstotal,bldgarea,lotarea,numfloors,yearbuilt,ownername", $where: `bbl in (${inClause})`, $limit: "5000" });
    try { const rows = await soqlFetch(ACRIS_BASE, PLUTO_DATASET, p); for (const r of rows) { const key = String(parseInt(String(r.bbl), 10)); out[key] = r; } }
    catch (e) { onChunkFail(); console.log("pluto chunk failed:", String(e)); }
  }
  return out;
}

async function run(sinceISO: string, untilISO: string | null) {
  const start = Date.now(); const overBudget = () => Date.now() - start > DEADLINE_MS;
  const where = `doc_type IN ('DEED','DEEDO','DEEDP') AND document_amt >= ${PRICE_FLOOR} AND recorded_datetime >= '${sinceISO}T00:00:00.000'${untilISO ? ` AND recorded_datetime < '${untilISO}T00:00:00.000'` : ""}`;
  const masters = await soqlFetchAll("bnx9-e6tj", where, "recorded_datetime DESC", 1000, MASTER_CAP);
  const docIds = masters.map((m) => m.document_id);
  let hitDeadline = false;

  const parties: Record<string, any> = {};
  for (let i = 0; i < docIds.length && !overBudget(); i += ACRIS_IN_CHUNK) {
    const chunk = docIds.slice(i, i + ACRIS_IN_CHUNK);
    const rows = await soqlFetchAll("636b-3b5g", `document_id IN (${chunk.map((id) => `'${id}'`).join(",")})`, "document_id ASC");
    for (const r of rows) { if (!parties[r.document_id]) parties[r.document_id] = {}; const addr = [r.address_1, r.address_2, r.city, r.state, r.zip].filter(Boolean).join(", ");
      if (r.party_type === "1") { if (!parties[r.document_id].seller) { parties[r.document_id].seller = r.name; parties[r.document_id].seller_address = addr || null; } }
      else if (r.party_type === "2") { if (!parties[r.document_id].buyer) { parties[r.document_id].buyer = r.name; parties[r.document_id].buyer_address = addr || null; } } }
  }
  const legals: Record<string, any> = {};
  for (let i = 0; i < docIds.length && !overBudget(); i += ACRIS_IN_CHUNK) {
    const chunk = docIds.slice(i, i + ACRIS_IN_CHUNK);
    const rows = await soqlFetchAll("8h5j-fqxa", `document_id IN (${chunk.map((id) => `'${id}'`).join(",")})`, "document_id ASC");
    for (const r of rows) { if (!legals[r.document_id]) legals[r.document_id] = { street_number: r.street_number, street_name: r.street_name, borough_code: r.borough, block: r.block, lot: r.lot, property_type: r.property_type }; }
  }
  const bblByDoc: Record<string, string> = {};
  for (const doc of docIds) { const lg = legals[doc]; if (lg) { const bbl = buildBbl(lg.borough_code, lg.block, lg.lot); if (bbl) bblByDoc[doc] = bbl; } }
  let plutoChunksFailed = 0;
  const pluto = await fetchPlutoForBbls(Object.values(bblByDoc), () => plutoChunksFailed++);

  let rejected_residential = 0, qualified = 0, skipped_bad_address = 0;
  const assetCounts: Record<string, number> = {};
  const payload: any[] = [];
  for (const master of masters) {
    if (overBudget()) { hitDeadline = true; break; }
    const doc = master.document_id; const legal = legals[doc]; const party = parties[doc];
    if (!legal) continue;
    const salePrice = parseFloat(master.document_amt) || 0;
    if (salePrice < PRICE_FLOOR) continue;
    const streetNumber = (legal.street_number || "").trim(); const streetName = (legal.street_name || "").trim();
    if (!streetNumber || !streetName) continue;
    const bbl = bblByDoc[doc] || null;
    const acrisPType = legal.property_type || null;
    const pl = bbl ? pluto[String(parseInt(bbl, 10))] : null;
    const bldgclass = pl?.bldgclass || null;
    const unitsTotal = pl?.unitstotal ? parseInt(pl.unitstotal, 10) || null : null;

    if (acrisPType && ACRIS_RESIDENTIAL_REJECT.has(acrisPType) && !(bldgclass && /^[CDEFHKLO]/i.test(bldgclass))) { rejected_residential++; continue; }
    const byClass = classifyByBldgClass(bldgclass, acrisPType);
    if (byClass.reject) { rejected_residential++; continue; }
    if (bldgclass && /^[CD]/i.test(bldgclass) && unitsTotal != null && unitsTotal <= 4) { rejected_residential++; continue; }
    const assetType = byClass.assetType || classifyByAcris(acrisPType);
    if (!assetType) { rejected_residential++; continue; }

    const boroughName = BOROUGH_MAP[legal.borough_code] || BOROUGH_MAP[master.recorded_borough] || null;
    const address = [streetNumber, streetName, boroughName, "NY"].filter(Boolean).join(" ");
    const normalized = canonicalizeAddress(address);
    if (isBadAddress(address) || isBadAddress(normalized)) { skipped_bad_address++; continue; }

    const buyerName = party?.buyer && !isPlaceholderOwner(party.buyer) ? party.buyer : null;
    const sellerName = party?.seller && !isPlaceholderOwner(party.seller) ? party.seller : null;
    const sameParty = buyerName && sellerName && normalizeEntity(buyerName) === normalizeEntity(sellerName);
    const saleDate = master.document_date ? String(master.document_date).slice(0, 10) : null;
    const squareFeet = pl?.bldgarea ? parseInt(pl.bldgarea, 10) || null : null;
    const units = pl?.unitstotal ? parseInt(pl.unitstotal, 10) || null : null;

    let confidence = 40; if (buyerName) confidence += 20; if (sellerName) confidence += 15; if (bldgclass) confidence += 15; if (squareFeet) confidence += 10;
    qualified++; assetCounts[assetType] = (assetCounts[assetType] || 0) + 1;

    payload.push({
      shortcode: `ACRIS-${doc}`,
      address, address_norm: normalized, bbl,
      borough: boroughName, market: boroughName ? boroughName.toLowerCase() : null,
      asset_type: assetType,
      sale_price: salePrice, units, sqft: squareFeet,
      sale_date: saleDate, post_date: master.recorded_datetime ? String(master.recorded_datetime).slice(0, 10) : null,
      source_system: "acris", source_url: acrisSourceUrl(doc),
      confidence: Math.min(100, confidence),
      parse_status: confidence >= 60 && !sameParty ? "ok" : "needs_review",
      notes: `ACRIS ${doc} | ACRIS-type ${acrisPType || "?"} | DOF-class ${bldgclass || "?"} | ${units ?? "?"} units | ${squareFeet ?? "?"} sqft | BBL ${bbl}`,
      buyer: buyerName, buyer_norm: normalizeEntity(buyerName),
      seller: sameParty ? null : sellerName, seller_norm: sameParty ? null : normalizeEntity(sellerName),
      buyer_address: party?.buyer_address || null, seller_address: party?.seller_address || null,
    });
  }

  const totals = newTotals();
  const errSamples: string[] = [];
  await upsertDeals(supa, payload, totals, errSamples, 500, () => {
    if (overBudget()) { hitDeadline = true; return true; }
    return false;
  });

  const summary = { ok: true, window_since: sinceISO, window_until: untilISO, masters: masters.length, qualified, rejected_residential_prefilter: rejected_residential, skipped_bad_address, pluto_chunks_failed: plutoChunksFailed, hit_deadline: hitDeadline, ...totals, asset_breakdown: assetCounts, error_samples: errSamples, elapsed_ms: Date.now() - start };
  console.log("acris-v2 summary:", JSON.stringify(summary));
  return summary;
}

Deno.serve(async (req: Request) => {
  let conf: Record<string, string>;
  try {
    conf = await loadConfig(supa, ["dealflow_secret"]);
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
  if (!authorized(req.headers.get("x-acris-secret"), conf.dealflow_secret)) return json({ error: "unauthorized" }, 401);
  try {
    const body = await req.json().catch(() => ({}));
    const since = body.since || new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
    const until = body.until || null;
    // These are interpolated into SoQL — accept strict ISO days only.
    if (!ISO_DAY.test(String(since)) || (until && !ISO_DAY.test(String(until)))) {
      return json({ ok: false, error: "since/until must be YYYY-MM-DD" }, 400);
    }
    return json(await run(since, until));
  } catch (e) { console.log("acris-v2 fatal:", String(e)); return json({ ok: false, error: String(e) }, 500); }
});
