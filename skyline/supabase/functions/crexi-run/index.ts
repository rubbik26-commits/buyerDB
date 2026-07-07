// crexi-run (Supabase-native rewrite — STAGED, deploy pending tool approval):
// starts the Crexi Apify actor (NYC for-sale, 365d) with a cost cap.
// Secrets from app_config instead of source. v2: shared plumbing, fail-closed
// auth, Apify token via Authorization header (kept out of proxy/edge logs).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { authorized, json, loadConfig, serviceClient } from "../_shared/mod.ts";

const supa = serviceClient();
const MAX_CHARGE_USD = 3;

Deno.serve(async (req: Request) => {
  let body: any = {}; try { body = await req.json(); } catch { /* empty ok */ }
  let conf: Record<string, string>;
  try {
    conf = await loadConfig(supa, ["dealflow_secret", "apify_token", "apify_crexi_actor"]);
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
  if (!authorized(body.secret, conf.dealflow_secret)) return json({ error: "unauthorized" }, 401);
  try {
    const res = await fetch(`https://api.apify.com/v2/acts/${conf.apify_crexi_actor}/runs?maxTotalChargeUsd=${MAX_CHARGE_USD}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${conf.apify_token}` },
      body: JSON.stringify({ deal_type: "buy", location: "New York, NY", publication_date: "365_days", listing_status: ["active_listing"] }),
    });
    const data = await res.json();
    return json({ ok: res.ok, runId: data?.data?.id, datasetId: data?.data?.defaultDatasetId, status: data?.data?.status, error: data?.error });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
});
