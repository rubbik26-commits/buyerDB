import { effectiveSupabasePublishableKey, effectiveSupabaseUrl, netlifyEnv } from "./public-config.mts";

export type Json = Record<string, any>;
const env = netlifyEnv;

export function config() {
  const url = effectiveSupabaseUrl();
  const key = effectiveSupabasePublishableKey();
  const runtimeSecret = env("SCRAPER_TRIGGER_SECRET") || env("SYNC_SECRET") || env("CRON_SECRET");
  if (!url || !key) throw new Error("The Supabase URL/public key is not configured for the Netlify runtime.");
  return { url, key, runtimeSecret };
}

async function rawRpc(name: string, body: Json = {}) {
  const { url, key } = config();
  const response = await fetch(`${url}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${name} HTTP ${response.status}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : {};
}

export async function runtimeRpc(name: string, body: Json = {}) {
  const { runtimeSecret } = config();
  if (!runtimeSecret) {
    throw new Error("The scraper runtime credential is not configured. Set SCRAPER_TRIGGER_SECRET to the credential configured for the Supabase runtime RPCs; SUPABASE_JWT_SECRET is not a runtime credential.");
  }
  return rawRpc(name, { p_secret: runtimeSecret, ...body });
}

export async function rpc(name: string, body: Json = {}) {
  if (name === "api_request_scrape") {
    return rawRpc("api_request_scrape", { job: body.job, user_id: body.user_id, options: body.options || {} });
  }
  if (name === "sync_upsert_deals") return runtimeRpc("sbi_runtime_sync", { p_rows: body.rows || [] });
  if (name === "upsert_broker_contacts") return runtimeRpc("sbi_runtime_broker_contacts", { p_rows: body.rows || [] });
  if (name === "sbi_rolling_targets") return runtimeRpc("sbi_runtime_rolling_targets", { p_lim: body.lim || 400 });
  if (name === "sbi_rolling_apply") return runtimeRpc("sbi_runtime_rolling_apply", body);
  if (name === "sbi_phase2_targets") return runtimeRpc("sbi_runtime_phase2_targets", { p_lim: body.lim || 400 });
  if (name === "sbi_apply_acris_party_fill") return runtimeRpc("sbi_runtime_phase2_apply", body);
  return rawRpc(name, body);
}

export async function updateRun(runId: string, status: string, stats: Json = {}, error: string | null = null) {
  return runtimeRpc("sbi_runtime_update_run", {
    p_run_id: runId,
    p_status: status,
    p_stats: stats,
    p_error: error,
  });
}

export async function invokeEdge(name: string, body: Json, extraHeaders: Record<string, string> = {}) {
  const { url, key, runtimeSecret } = config();
  const response = await fetch(`${url}/functions/v1/${name}`, {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...(runtimeSecret ? { "x-runtime-secret": runtimeSecret } : {}),
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${name} HTTP ${response.status}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : {};
}

export function getEnv(name: string) { return env(name); }

export function hasRuntimeCredential() { return Boolean(config().runtimeSecret); }
