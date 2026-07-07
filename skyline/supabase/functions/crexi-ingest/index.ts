// crexi-ingest (Supabase-native rewrite — STAGED, deploy pending tool approval):
// Apify Crexi dataset -> Skyline Postgres via sync_upsert_deals(); broker
// contacts via upsert_broker_contacts(). Base44 removed. Secrets from app_config.
// v2: shared plumbing, fail-closed auth, Apify token via Authorization header
// (not query string), brokers keyed on name+company (two different JOHN SMITHs
// at different firms must not merge), active listings land as needs_review —
// an asking price is not a closed-sale fact.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {
  authorized, canonicalizeAddress, json, loadConfig, newTotals, serviceClient, upsertDeals,
} from "../_shared/mod.ts";

const supa = serviceClient();
const DEADLINE_MS = 118_000;

const BORO_BY_COUNTY: Record<string,string> = { "KINGS":"Brooklyn","NEW YORK":"Manhattan","QUEENS":"Queens","BRONX":"Bronx","RICHMOND":"Staten Island" };
const BORO_BY_CITY: Record<string,string> = { "BROOKLYN":"Brooklyn","NEW YORK":"Manhattan","MANHATTAN":"Manhattan","QUEENS":"Queens","BRONX":"Bronx","STATEN ISLAND":"Staten Island","LONG ISLAND CITY":"Queens","ASTORIA":"Queens","FLUSHING":"Queens" };
const ASSET_MAP: Record<string,string> = { "Retail":"Retail","Office":"Office","Industrial":"Industrial","Mixed Use":"Mixed-Use","Multifamily":"Multifamily","Land":"Development Site","Self Storage":"Storage","Hospitality":"Hotel","Special Purpose":"Special Purpose","Senior Living":"Multifamily" };
const EXCLUDE_TYPES = new Set(["Business for Sale","Note/Loan"]);

async function run(body: any, conf: Record<string,string>) {
  const start = Date.now(); const over = () => Date.now()-start > DEADLINE_MS;
  const token = body.apifyToken || conf.apify_token;
  const actor = conf.apify_crexi_actor;
  if (!token || !actor) return { ok:false, error:"apify_token / apify_crexi_actor not configured" };
  const apifyHeaders = { Authorization: `Bearer ${token}` };
  let datasetId = body.datasetId;
  const errSamples: string[] = [];
  if (!datasetId) {
    try {
      const r = await fetch(`https://api.apify.com/v2/acts/${actor}/runs/last`, { headers: apifyHeaders });
      if (r.ok) { const d = await r.json(); datasetId = d?.data?.defaultDatasetId; }
      else if (errSamples.length < 5) errSamples.push(`apify runs/last ${r.status}`);
    } catch (e) { if (errSamples.length < 5) errSamples.push("apify runs/last: " + String(e)); }
  }
  if (!datasetId) return { ok:false, error:"no datasetId (and no recent Crexi run found)", error_samples: errSamples };

  const items: any[] = [];
  let fetchIncomplete = false;
  for (let off=0; off<100000 && !over(); off+=1000){
    const res = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?limit=1000&offset=${off}`, { headers: apifyHeaders });
    if(!res.ok){ fetchIncomplete = true; if (errSamples.length < 5) errSamples.push(`apify dataset ${res.status} at offset ${off}`); break; }
    const batch = await res.json(); if(!Array.isArray(batch)||batch.length===0) break; items.push(...batch); if(batch.length<1000) break;
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
      const phone = ag.phone && /\d/.test(String(ag.phone)) ? String(ag.phone) : null;
      const company = ag.brokerage?.name || ag.agency?.name || it.relationships?.agency?.name || null;
      const key = `${String(name).trim().toUpperCase()}|${String(company||"").trim().toUpperCase()}`;
      const cur = brokerAgg.get(key);
      if (cur) { if(!cur.phone&&phone)cur.phone=phone; }
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
      sale_date: null, // active listing: activated_at is a listing date, not a sale date
      post_date: it.listing?.updated_at ? String(it.listing.updated_at).slice(0,10) : new Date().toISOString().slice(0,10),
      source_system: "crexi",
      source_url: it.source_context?.listing_url || it.entity?.url || null,
      // Asking price on an ACTIVE listing is not a closed-sale fact; the row
      // stays needs_review until a human (or a closing record) confirms it.
      confidence: 55, parse_status: "needs_review",
      notes: `Crexi ACTIVE listing (price = asking, not closed) | ${realTypes.join(", ")} | status ${it.listing?.listing_status||"?"} | activated ${it.listing?.activated_at ? String(it.listing.activated_at).slice(0,10) : "?"} | ${agents.length} broker(s)`,
      bbl: null, buyer: null, buyer_norm: null, seller: null, seller_norm: null,
      buyer_address: null, seller_address: null,
    });
  }

  const totals = newTotals();
  await upsertDeals(supa, dealRows, totals, errSamples, 500, over);

  let brokers: any = null;
  if (brokerAgg.size && !over()) {
    const rows = [...brokerAgg.values()];
    const { data, error } = await supa.rpc("upsert_broker_contacts", { rows });
    brokers = error ? { error: error.message } : data;
  }

  const summary = { ok: !fetchIncomplete, dataset_id:datasetId, dataset_items:items.length, fetch_incomplete: fetchIncomplete, nyc_listings:dealRows.length, skipped_non_nyc:skippedNonNyc, skipped_type:skippedType, deals:totals, brokers, error_samples:errSamples, elapsed_ms:Date.now()-start, hit_deadline:over() };
  console.log("crexi-ingest:", JSON.stringify(summary));
  return summary;
}

Deno.serve(async (req: Request) => {
  let body:any={}; try{ body=await req.json(); }catch{ /* empty ok */ }
  let conf: Record<string,string>;
  try {
    conf = await loadConfig(supa, ["dealflow_secret","apify_token","apify_crexi_actor"], ["dealflow_secret"]);
  } catch (e) {
    return json({ ok:false, error:String(e) }, 500);
  }
  if(!authorized(body.secret, conf.dealflow_secret)) return json({error:"unauthorized"}, 401);
  try{ return json(await run(body, conf)); }
  catch(e){ return json({ok:false,error:String(e)}, 500); }
});
