import { getEnv, rpc, type Json } from "./supabase.mts";

export async function runCrexi(options: Json = {}) {
  const token = getEnv("APIFY_TOKEN");
  const actor = getEnv("APIFY_CREXI_ACTOR");
  if (!token || !actor) return { status: "quota_blocked", error: "APIFY_TOKEN or APIFY_CREXI_ACTOR is not configured" };
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  let datasetId = String(options.dataset_id || "");
  if (!datasetId) {
    const response = await fetch(`https://api.apify.com/v2/acts/${encodeURIComponent(actor)}/runs?maxTotalChargeUsd=3`, {
      method: "POST", headers,
      body: JSON.stringify({ deal_type: "buy", location: "New York, NY", publication_date: "365_days", listing_status: ["active_listing"] }),
    });
    const started = await response.json();
    if (!response.ok) throw new Error(`Apify start HTTP ${response.status}: ${JSON.stringify(started).slice(0, 300)}`);
    const runId = started?.data?.id;
    datasetId = started?.data?.defaultDatasetId || "";
    const deadline = Date.now() + 8 * 60_000;
    while (runId && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10000));
      const poll = await fetch(`https://api.apify.com/v2/actor-runs/${runId}`, { headers });
      const state = await poll.json();
      if (["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"].includes(state?.data?.status)) {
        datasetId = state?.data?.defaultDatasetId || datasetId;
        if (state?.data?.status !== "SUCCEEDED") throw new Error(`Apify run ${state?.data?.status}`);
        break;
      }
    }
  }
  if (!datasetId) throw new Error("Crexi run produced no Apify dataset id.");

  const response = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?clean=true&limit=${Math.min(5000, Number(options.limit || 2500))}`, { headers });
  const items = await response.json();
  if (!response.ok || !Array.isArray(items)) throw new Error(`Apify dataset HTTP ${response.status}`);

  const countyMap: Record<string, string> = { KINGS: "Brooklyn", "NEW YORK": "Manhattan", QUEENS: "Queens", BRONX: "Bronx", RICHMOND: "Staten Island" };
  const cityMap: Record<string, string> = { BROOKLYN: "Brooklyn", "NEW YORK": "Manhattan", MANHATTAN: "Manhattan", QUEENS: "Queens", BRONX: "Bronx", "STATEN ISLAND": "Staten Island", "LONG ISLAND CITY": "Queens", ASTORIA: "Queens", FLUSHING: "Queens" };
  const assetMap: Record<string, string> = { Retail: "Retail", Office: "Office", Industrial: "Industrial", "Mixed Use": "Mixed-Use", Multifamily: "Multifamily", Land: "Development Site", "Self Storage": "Storage", Hospitality: "Hotel", "Special Purpose": "Commercial", "Senior Living": "Multifamily" };
  const deals: Json[] = [];
  const brokers = new Map<string, Json>();
  for (const item of items) {
    const location = item.location || {};
    const state = location?.verified?.state?.code || location.state || "";
    if (String(state).toUpperCase() !== "NY") continue;
    const types = Array.isArray(item.property?.property_types) ? item.property.property_types.filter((type: string) => !["Business for Sale", "Note/Loan"].includes(type)) : [];
    if (!types.length) continue;
    const listingId = item.listing?.listing_id || item.record_id || item.source_context?.external_ids?.crexi_listing_id;
    if (!listingId) continue;
    const county = String(location.county || "").toUpperCase().replace(/\s+COUNTY$/, "");
    const city = String(location.city || "").toUpperCase();
    const borough = countyMap[county] || cityMap[city] || null;
    const address = String(location.address || location.full_address || item.entity?.title || "").trim();
    deals.push({
      shortcode: `CREXI-${listingId}`,
      address: address || `Crexi listing ${listingId}`,
      borough,
      market: borough ? borough.toLowerCase() : null,
      asset_type: assetMap[types[0]] || "Commercial",
      sale_price: Number(item.pricing?.asking_price) || null,
      units: null, sqft: null, sale_date: null,
      post_date: item.listing?.updated_at || new Date().toISOString(),
      source_system: "crexi",
      source_url: item.source_context?.listing_url || item.entity?.url || null,
      confidence: 55,
      parse_status: "needs_review",
      verification_status: "needs_review",
      record_quality: "needs_review",
      notes: `Crexi ACTIVE listing — asking price, not a closed-sale fact | ${types.join(", ")}`,
      provenance: { source: "crexi", dataset_id: datasetId, listing_status: item.listing?.listing_status || null },
    });
    for (const agent of Array.isArray(item.relationships?.agents) ? item.relationships.agents : []) {
      const name = agent.full_name || [agent.first_name, agent.last_name].filter(Boolean).join(" ");
      if (!name) continue;
      const company = agent.brokerage?.name || agent.agency?.name || item.relationships?.agency?.name || null;
      const key = `${name.toUpperCase()}|${String(company || "").toUpperCase()}`;
      if (!brokers.has(key)) brokers.set(key, { name, company, phone: agent.phone && /\d/.test(String(agent.phone)) ? String(agent.phone) : null });
    }
  }
  const dealResult = deals.length ? await rpc("sync_upsert_deals", { rows: deals }) : { inserted: 0, dup: 0, errors: 0 };
  const brokerResult = brokers.size ? await rpc("upsert_broker_contacts", { rows: [...brokers.values()] }) : { contacts_inserted: 0 };
  return { status: dealResult.errors ? "completed_with_errors" : "completed", dataset_id: datasetId, dataset_items: items.length, listings: deals.length, deals: dealResult, brokers: brokerResult };
}
