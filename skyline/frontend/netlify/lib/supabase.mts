export type Json = Record<string, any>;
const env = (name: string) => (globalThis as any).Netlify?.env?.get?.(name) || "";

export function config() {
  const url = (env("SUPABASE_URL") || env("VITE_API_URL")).replace(/\/$/, "");
  const key = env("SUPABASE_PUBLISHABLE_KEY") || env("SUPABASE_ANON_KEY") || env("VITE_SUPABASE_ANON_KEY");
  const runtimeSecret = env("SCRAPER_TRIGGER_SECRET") || env("SYNC_SECRET") || env("CRON_SECRET") || env("SUPABASE_JWT_SECRET");
  if (!url || !key) throw new Error("The Supabase URL/public key is not configured for the Netlify runtime.");
  return { url, key, runtimeSecret };
}

export async function rpc(name: string, body: Json = {}) {
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
  if (!runtimeSecret) throw new Error("The Netlify scraper runtime credential is not configured.");
  return rpc(name, { p_secret: runtimeSecret, ...body });
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
