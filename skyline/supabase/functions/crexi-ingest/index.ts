// crexi-ingest (Supabase-native rewrite — STAGED, deploy pending tool approval):
// Apify Crexi dataset -> Skyline Postgres via sync_upsert_deals(); broker
// contacts via upsert_broker_contacts(). Base44 removed. Secrets from app_config.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const DEADLINE_MS = 118_000;

const BORO_BY_COUNTY: Record<string,string> = { "KINGS":"Brooklyn","NEW YORK":"Manhattan","QUEENS":"Queens","BRONX":"Bronx","RICHMOND":"Staten Island" };
const BORO_BY_CITY: Record<string,string> = { "BROOKLYN":"Brooklyn","NEW YORK":"Manhattan","MANHATTAN":"Manhattan","QUEENS":"Queens","BRONX":"Bronx","STATEN ISLAND":"Staten Island","LONG ISLAND CITY":"Queens","ASTORIA":"Queens","FLUSHING":"Queens" };
const ASSET_MAP: Record<string,string> = { "Retail":"Retail","Office":"Office","Industrial":"Industrial","Mixed Use":"Mixed-Use","Multifamily":"Multifamily","Land":"Development Site","Self Storage":"Storage","Hospitality":"Hotel","Special Purpose":"Special Purpose","Senior Living":"Multifamily" };
const EXCLUDE_TYPES = new Set(["Business for Sale","Note/Loan"]);

const SUFFIX_MAP: Record<string,string> = { STREET:"ST",ST:"ST",AVENUE:"AVE",AVE:"AVE",BOULEVARD:"BLVD",BLVD:"BLVD",ROAD:"RD",RD:"RD",DRIVE:"DR",DR:"DR",LANE:"LN",PLACE:"PL",PL:"PL",PARKWAY:"PKWY",SQUARE:"SQ",COURT:"CT",TERRACE:"TER" };
const DIRECTION_MAP: Record<string,string> = { EAST:"E",WEST:"W",NORTH:"N",SOUTH:"S" };
function canonicalizeAddress(raw: string): string { if(!raw||typeof raw!=="string")return""; let a=raw.trim().toUpperCase().replace(/[.,;:()]/g," ").replace(/\s+(NY|NYC|NEW YORK|MANHATTAN|BROOKLYN|QUEENS|BRONX|STATEN ISLAND|KINGS COUNTY|[A-Z ]+COUNTY)$/g,"").replace(/\s+\d{5}(-\d{4})?$/,"").replace(/\s+/g," ").trim(); if(!a)return""; return a.split(" ").map((t)=>DIRECTION_MAP[t]||SUFFIX_MAP[t]||t).join(" ").trim(); }

async function run(body: any, conf: Record<string,string>) {
  const start = Date.now(); const over = () => Date.now()-start > DEADLINE_MS;
  const token = body.apifyToken || conf.apify_token;
  const actor = conf.apify_crexi_actor;
  let datasetId = body.datasetId;
  if (!datasetId) {
    try {
      const r = await fetch(`https://api.apify.com/v2/acts/${actor}/runs/last?token=${token}`);
      const d = await r.json(); datasetId = d?.data?.defaultDatasetId;
    } catch { /* fall through */ }
  }
  if (!datasetId || !token) return { ok:false, error:"no datasetId (and no recent Crexi run found)" };

  const items: any[] = [];
  for (let off=0; off<100000; off+=1000){
    const res = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?token=${token}&limit=1000&offset=${off}`);
    if(!res.ok) break; const batch = await res.json(); if(!Array.isArray(batch)||batch.length===0) break; items.push(...batch); if(batch.length<1000) break;
  }

  const dealRows: any[] = [];
  const brokerAgg = new Map<string, any>();
  let skippedNonNyc=0, skippedType=0;

  for (const it of items) {
    const loc = it.location || {};
    const stateCode = loc?.verified?.state?.code || loc.state || "";
    if (String(stateCode).toUpperCase() !== "NY") { skippedNonNyc++; continue; }
    const types: string[] = Array.isArray(it.property?.property_types) ? it.property.property_types : [];
    const realTypes = types.filter((t)=>!EXCLUDE_TYPES.has(t));
    if (realTypes.length === 0) { skippedType++; continue; }
    const assetType = ASSET_MAP[realTypes[0]] || "Commercial";

    const county = String(loc.county||"").toUpperCase().replace(/\s+COUNTY$/,"");
    const city = String(loc.city||"").toUpperCase();
    const borough = BORO_BY_COUNTY[county] || BORO_BY_CITY[city] || null;
    const address = (loc.address || loc.full_address || it.entity?.title || "").trim();
    const listingId = it.listing?.listing_id || it.record_id || it.source_context?.external_ids?.crexi_listing_id;
    if (!listingId) continue;

    const agents = Array.isArray(it.relationships?.agents) ? it.relationships.agents : [];
    for (const ag of agents) {
      const name = ag.full_name || [ag.first_name,ag.last_name].filter(Boolean).join(" ");
      if (!name || !String(name).trim()) continue;
      const key = String(name).trim().toUpperCase();
      const phone = ag.phone && /\d/.test(String(ag.phone)) ? String(ag.phone) : null;
      const company = ag.brokerage?.name || ag.agency?.name || it.relationships?.agency?.name || null;
      const cur = brokerAgg.get(key);
      if (cur) { if(!cur.phone&&phone)cur.phone=phone; if(!cur.company&&company)cur.company=company; }
      else brokerAgg.set(key, { name:String(name).trim(), phone, company });
    }

    dealRows.push({
      shortcode: `CREXI-${listingId}`,
      address: address || `Crexi listing ${listingId}`,
      address_norm: canonicalizeAddress(address) || `CREXI LISTING ${listingId}`,
      borough, market: borough ? borough.toLowerCase() : null,
      asset_type: assetType,
      sale_price: Number(it.pricing?.asking_price) || null,
      units: null, sqft: null,
      sale_date: it.listing?.activated_at ? String(it.listing.activated_at).slice(0,10) : null,
      post_date: it.listing?.updated_at ? String(it.listing.updated_at).slice(0,10) : new Date().toISOString().slice(0,10),
      source_system: "crexi",
      source_url: it.source_context?.listing_url || it.entity?.url || null,
      confidence: 70, parse_status: "ok",
      notes: `Crexi active listing | ${realTypes.join(", ")} | status ${it.listing?.listing_status||"?"} | ${agents.length} broker(s)`,
      bbl: null, buyer: null, buyer_norm: null, seller: null, seller_norm: null,
      buyer_address: null, seller_address: null,
    });
  }

  const totals: Record<string, number> = { inserted: 0, dup: 0, skipped_residential: 0, skipped_invalid: 0, parties: 0, contacts: 0, errors: 0 };
  const errSamples: string[] = [];
  for (let i = 0; i < dealRows.length && !over(); i += 500) {
    const { data, error } = await supa.rpc("sync_upsert_deals", { rows: dealRows.slice(i, i + 500) });
    if (error) { totals.errors += Math.min(500, dealRows.length - i); if (errSamples.length < 5) errSamples.push("rpc: " + error.message); }
    else if (data) { for (const k of Object.keys(totals)) totals[k] += Number(data[k] ?? 0); for (const s of (data.error_samples ?? [])) if (errSamples.length < 5) errSamples.push(String(s)); }
  }

  let brokers: any = null;
  if (brokerAgg.size && !over()) {
    const rows = [...brokerAgg.values()];
    const { data, error } = await supa.rpc("upsert_broker_contacts", { rows });
    brokers = error ? { error: error.message } : data;
  }

  const summary = { ok:true, dataset_id:datasetId, dataset_items:items.length, nyc_listings:dealRows.length, skipped_non_nyc:skippedNonNyc, skipped_type:skippedType, deals:totals, brokers, error_samples:errSamples, elapsed_ms:Date.now()-start, hit_deadline:over() };
  console.log("crexi-ingest:", JSON.stringify(summary));
  return summary;
}

Deno.serve(async (req: Request) => {
  let body:any={}; try{ body=await req.json(); }catch{ /* empty ok */ }
  const { data: cfg } = await supa.from("app_config").select("key,value").in("key", ["dealflow_secret","apify_token","apify_crexi_actor"]);
  const conf = Object.fromEntries((cfg ?? []).map((r) => [r.key, r.value]));
  if(body.secret!==conf.dealflow_secret) return new Response(JSON.stringify({error:"unauthorized"}),{status:401,headers:{"Content-Type":"application/json"}});
  try{ return new Response(JSON.stringify(await run(body, conf)),{headers:{"Content-Type":"application/json"}}); }
  catch(e){ return new Response(JSON.stringify({ok:false,error:String(e)}),{status:500,headers:{"Content-Type":"application/json"}}); }
});
