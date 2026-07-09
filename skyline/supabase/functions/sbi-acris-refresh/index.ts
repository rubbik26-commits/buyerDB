import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const ACRIS_BASE = "https://data.cityofnewyork.us/resource";
const MASTER = "bnx9-e6tj";
const LEGALS = "8h5j-fqxa";
const PARTIES = "636b-3b5g";
const PLUTO = "64uk-42ks";
const PRICE_FLOOR = 1_000_000;
const DEFAULT_DAYS = 120;
const DEFAULT_LIMIT = 250;
const BORO: Record<string,string> = { "1":"Manhattan", "2":"Bronx", "3":"Brooklyn", "4":"Queens", "5":"Staten Island" };
const DOF_REJECT = new Set(["C0","C3","C6","C8","D0","D4","DC"]);
const CLASS_REJECT = new Set("ABIMNQTUWYZR".split(""));
const CLASS_MAP: Record<string,string> = { C:"Multifamily", D:"Multifamily", E:"Industrial", F:"Industrial", G:"Garage/Auto", H:"Hotel", J:"Entertainment", K:"Retail", L:"Office", O:"Office", P:"Entertainment", S:"Mixed-Use", V:"Development Site" };
const ACRIS_REJECT = new Set(["D1","D2","D3","D4","RG","RP","RV","SC","SP","MC","MP","SA","SM","CK","CA","BS","TS","MR","GR","PS","NA","PA"]);
const ACRIS_MAP: Record<string,string> = { CR:"Commercial", OF:"Office", RB:"Retail", IB:"Industrial", AP:"Multifamily", EA:"Entertainment", D5:"Multifamily", D6:"Multifamily", F1:"Mixed-Use", F4:"Mixed-Use", F5:"Mixed-Use", FS:"Mixed-Use", VL:"Development Site", VN:"Development Site", VR:"Development Site", SR:"Storage" };
const PLACEHOLDER = /^(unknown|n\/?a|not specified|not provided|not disclosed|undisclosed|confidential|various|null|none|tbd|tba|-+)$/i;

function json(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { "content-type":"application/json" }}); }
function enc(params: Record<string,string>) { const u = new URLSearchParams(); for (const [k,v] of Object.entries(params)) u.set(k,v); return u.toString(); }
async function soql(dataset: string, params: Record<string,string>) {
  const r = await fetch(`${ACRIS_BASE}/${dataset}.json?${enc(params)}`, { headers: { "user-agent":"Skyline SBI scraper/1.0" }});
  if (!r.ok) throw new Error(`${dataset} ${r.status}: ${(await r.text()).slice(0,200)}`);
  return await r.json();
}
async function soqlAll(dataset: string, where: string, order: string, limit = 1000, cap = 4000, select?: string) {
  const out: any[] = [];
  for (let offset = 0; out.length < cap; offset += limit) {
    const params: Record<string,string> = { "$where": where, "$order": order, "$limit": String(Math.min(limit, cap - out.length)) };
    if (offset) params["$offset"] = String(offset);
    if (select) params["$select"] = select;
    const rows = await soql(dataset, params);
    if (!Array.isArray(rows) || rows.length === 0) break;
    out.push(...rows);
    if (rows.length < limit) break;
  }
  return out;
}
function chunks<T>(xs: T[], n: number) { const out: T[][] = []; for (let i=0;i<xs.length;i+=n) out.push(xs.slice(i,i+n)); return out; }
function bbl(bc: any, block: any, lot: any) { const b=String(bc||"").trim(), blk=String(block||"").replace(/\D/g,""), lt=String(lot||"").replace(/\D/g,""); return /^[1-5]$/.test(b)&&blk&&lt&&blk.length<=5&&lt.length<=4 ? `${b}${blk.padStart(5,"0")}${lt.padStart(4,"0")}` : null; }
function classify(bldg: any, ptype: any, units: any) {
  const bc = String(bldg||"").toUpperCase();
  if (bc) { const two=bc.slice(0,2), L=bc[0]; if (DOF_REJECT.has(two) || CLASS_REJECT.has(L)) return null; if ((L==="C"||L==="D") && units !== null && units !== undefined && Number(units) <= 4) return null; if (CLASS_MAP[L]) return CLASS_MAP[L]; }
  const pt = String(ptype||"").toUpperCase();
  if (pt === "CC" || pt === "CP") return null;
  if (ACRIS_REJECT.has(pt) && !(bc && /^[CDEFHKLO]/i.test(bc))) return null;
  return ACRIS_MAP[pt] || (pt ? "Commercial" : null);
}
function cleanParty(v: any) { const s=String(v||"").trim(); return !s || PLACEHOLDER.test(s) ? null : s; }

Deno.serve(async (req: Request) => {
  const started = Date.now();
  const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  let body: any = {}; try { body = await req.json(); } catch {}
  const max = Math.max(1, Math.min(1000, Number(body.limit || DEFAULT_LIMIT)));
  const days = Math.max(1, Math.min(365, Number(body.days || DEFAULT_DAYS)));
  let runId = body.run_id || null;
  const stats: any = { masters:0, candidates:0, upserted:0, duplicate_or_updated:0, rejected_class:0, no_legals:0, bad_address:0, below_floor:0, errors:0, error_samples:[] };
  try {
    if (!runId) {
      const { data: queued } = await supa.from("sbi_source_runs").select("run_id").in("job", ["acris_refresh","full_refresh"]).eq("status","requested").order("started_at", { ascending:true }).limit(1).maybeSingle();
      runId = queued?.run_id || null;
    }
    if (runId) await supa.from("sbi_source_runs").update({ status:"running", started_at:new Date().toISOString(), stats:{ stage:"running", function:"sbi-acris-refresh" }}).eq("run_id", runId);
    const since = new Date(Date.now() - days*86400000).toISOString().slice(0,10);
    const where = `doc_type IN ('DEED','DEEDO','DEEDP') AND document_amt >= ${PRICE_FLOOR} AND recorded_datetime >= '${since}T00:00:00.000'`;
    const masters = (await soqlAll(MASTER, where, "recorded_datetime DESC", 1000, max)) as any[];
    stats.masters = masters.length;
    const docIds = [...new Set(masters.map(m => m.document_id).filter(Boolean))];
    const legals = new Map<string, any>(), parties = new Map<string, any>();
    for (const ch of chunks(docIds, 150)) {
      const ids = ch.map(d=>`'${String(d).replace(/'/g,"''")}'`).join(",");
      for (const r of await soqlAll(LEGALS, `document_id IN (${ids})`, "document_id ASC", 1000, 10000)) if (!legals.has(r.document_id)) legals.set(r.document_id, r);
      for (const r of await soqlAll(PARTIES, `document_id IN (${ids})`, "document_id ASC, party_type ASC, name ASC", 1000, 10000)) {
        const cur = parties.get(r.document_id) || {};
        const addr = [r.address_1,r.address_2,r.city,r.state,r.zip].filter(Boolean).join(", ") || null;
        if (r.party_type === "1" && !cur.seller) { cur.seller = r.name; cur.seller_address = addr; }
        if (r.party_type === "2" && !cur.buyer) { cur.buyer = r.name; cur.buyer_address = addr; }
        parties.set(r.document_id, cur);
      }
    }
    const bbls = [...new Set([...legals.values()].map(l=>bbl(l.borough,l.block,l.lot)).filter(Boolean))];
    const pluto = new Map<string, any>();
    for (const ch of chunks(bbls, 100)) {
      const rows = await soql(PLUTO, { "$select":"bbl,bldgclass,unitstotal,bldgarea,lotarea,yearbuilt", "$where":`bbl in (${ch.map(x=>`'${x}'`).join(",")})`, "$limit":"5000" });
      for (const r of rows) if (r.bbl) pluto.set(String(Math.trunc(Number(r.bbl))), r);
    }
    for (const m of masters) {
      try {
        const doc = m.document_id, lg = legals.get(doc); if (!lg) { stats.no_legals++; continue; }
        const num=String(lg.street_number||"").trim(), name=String(lg.street_name||"").trim();
        if (!num || !name || !/^\d/.test(num)) { stats.bad_address++; continue; }
        const price = Number(m.document_amt || 0); if (price < PRICE_FLOOR) { stats.below_floor++; continue; }
        const bb = bbl(lg.borough, lg.block, lg.lot); const pl = bb ? pluto.get(String(Number(bb))) : null;
        const units = pl?.unitstotal ? Number(pl.unitstotal) : null;
        const asset = classify(pl?.bldgclass, lg.property_type, units); if (!asset) { stats.rejected_class++; continue; }
        const borough = BORO[String(lg.borough||"").trim()] || null;
        const address = [num, name.replace(/\w\S*/g, (t:string)=>t[0].toUpperCase()+t.slice(1).toLowerCase()), borough, "NY"].filter(Boolean).join(" ");
        const pt = parties.get(doc) || {}; const buyer = cleanParty(pt.buyer); const seller0 = cleanParty(pt.seller); const seller = buyer && seller0 && buyer.toUpperCase() === seller0.toUpperCase() ? null : seller0;
        const sqft = pl?.bldgarea ? Number(pl.bldgarea) : null;
        const conf = Math.min(100, 40 + (buyer?20:0) + (seller?15:0) + (pl?.bldgclass?15:0) + (sqft?10:0));
        const sourceUrl = `https://a836-acris.nyc.gov/DS/DocumentSearch/DocumentDetail?doc_id=${doc}`;
        const { data, error } = await supa.rpc("sbi_ingest_deal", { p_address: address, p_borough: borough, p_neighborhood: null, p_market: borough ? borough.toLowerCase() : null, p_asset_type: asset, p_transaction_type: "sale", p_sale_price: price, p_units: units, p_sqft: sqft, p_sale_date: (m.document_date||"").slice(0,10) || null, p_post_date: (m.recorded_datetime||new Date().toISOString()), p_buyer: buyer, p_seller: seller, p_source_system: "acris", p_source_url: sourceUrl, p_source_key: `ACRIS-${doc}`, p_acris_doc_id: doc, p_confidence: conf, p_parse_status: conf >= 60 ? "ok" : "needs_review", p_verification_status: "source_verified", p_record_quality: "ok", p_notes: `ACRIS ${doc} | fresh-window ingest | class ${pl?.bldgclass || "?"} | BBL ${bb || "?"}`, p_provenance: { source:"acris", document_id:doc, bbl:bb, deed_amount:price, buyer_address:pt.buyer_address||null, seller_address:pt.seller_address||null } });
        if (error) throw new Error(error.message);
        stats.candidates++; if (data?.status === "upserted") stats.upserted++; else stats.duplicate_or_updated++;
        await supa.from("sbi_fetch_ledger").upsert({ source:"acris", source_key:String(doc), disposition:"processed", payload_hash:String(price) });
      } catch(e) { stats.errors++; if (stats.error_samples.length < 5) stats.error_samples.push(String(e)); }
    }
    const status = stats.errors ? "completed_with_errors" : "completed";
    if (runId) await supa.from("sbi_source_runs").update({ status, finished_at:new Date().toISOString(), stats, error: stats.errors ? stats.error_samples.join(" | ") : null }).eq("run_id", runId);
    return json({ ok: stats.errors === 0, run_id: runId, status, stats, elapsed_ms: Date.now()-started });
  } catch (e) {
    if (runId) await supa.from("sbi_source_runs").update({ status:"failed", finished_at:new Date().toISOString(), stats, error:String(e) }).eq("run_id", runId);
    return json({ ok:false, run_id:runId, error:String(e), stats }, 500);
  }
});