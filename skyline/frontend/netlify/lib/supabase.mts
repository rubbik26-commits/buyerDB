export type Json = Record<string, any>;
const env = (name: string) => (globalThis as any).Netlify?.env?.get?.(name) || "";

export function config() {
  const url = (env("SUPABASE_URL") || env("VITE_API_URL")).replace(/\/$/, "");
  const key = env("SUPABASE_SERVICE_ROLE_KEY") || env("SUPABASE_SERVICE_KEY");
  if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for scraper execution.");
  return { url, key };
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

export async function table(path: string, init: RequestInit = {}) {
  const { url, key } = config();
  const headers = new Headers(init.headers || {});
  headers.set("apikey", key);
  headers.set("Authorization", `Bearer ${key}`);
  if (init.body) headers.set("Content-Type", "application/json");
  const response = await fetch(`${url}/rest/v1/${path}`, { ...init, headers });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} HTTP ${response.status}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : null;
}

export async function updateRun(runId: string, status: string, stats: Json = {}, error: string | null = null) {
  await table(`sbi_source_runs?run_id=eq.${encodeURIComponent(runId)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      status,
      stats,
      error,
      ...(status === "running" ? { started_at: new Date().toISOString() } : { finished_at: new Date().toISOString() }),
    }),
  });
}

export async function invokeEdge(name: string, body: Json, extraHeaders: Record<string, string> = {}) {
  const { url, key } = config();
  const response = await fetch(`${url}/functions/v1/${name}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...extraHeaders },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${name} HTTP ${response.status}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : {};
}

export function getEnv(name: string) { return env(name); }
