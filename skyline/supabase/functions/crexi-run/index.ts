// crexi-run (Supabase-native rewrite — STAGED, deploy pending tool approval):
// starts the Crexi Apify actor (NYC for-sale, 365d) with a cost cap.
// Secrets from app_config instead of source.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const MAX_CHARGE_USD = 3;

Deno.serve(async (req: Request) => {
  let body: any = {}; try { body = await req.json(); } catch { /* empty ok */ }
  const { data: cfg } = await supa.from("app_config").select("key,value")
    .in("key", ["dealflow_secret", "apify_token", "apify_crexi_actor"]);
  const conf = Object.fromEntries((cfg ?? []).map((r) => [r.key, r.value]));
  if (body.secret !== conf.dealflow_secret) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
  }
  try {
    const res = await fetch(`https://api.apify.com/v2/acts/${conf.apify_crexi_actor}/runs?token=${conf.apify_token}&maxTotalChargeUsd=${MAX_CHARGE_USD}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deal_type: "buy", location: "New York, NY", publication_date: "365_days", listing_status: ["active_listing"] }),
    });
    const data = await res.json();
    return new Response(JSON.stringify({ ok: res.ok, runId: data?.data?.id, datasetId: data?.data?.defaultDatasetId, status: data?.data?.status, error: data?.error }), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
});
