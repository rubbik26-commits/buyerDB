import type { Config, Context } from "@netlify/functions";

const env = (name: string) => (globalThis as any).Netlify?.env?.get?.(name) || "";
const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });

async function rpc(name: string, body: Record<string, unknown> = {}) {
  const url = (env("SUPABASE_URL") || env("VITE_API_URL")).replace(/\/$/, "");
  const key = env("SUPABASE_ANON_KEY") || env("SUPABASE_PUBLISHABLE_KEY") || env("VITE_SUPABASE_ANON_KEY");
  if (!url || !key) throw new Error("Supabase public RPC environment is not configured.");
  const response = await fetch(`${url}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${name} HTTP ${response.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

export default async (_req: Request, _context: Context) => {
  try {
    const [health, workbench, runs, uploads] = await Promise.all([
      rpc("api_health"),
      rpc("api_workbench"),
      rpc("api_scraper_runs", { lim: 100 }),
      rpc("api_uploads_list"),
    ]);
    const sourceRuns = runs.runs || [];
    return json({
      totals: {
        deals: health.deals || workbench.stats?.deals || 0,
        properties: workbench.owner_targets?.length || 0,
        contacts: workbench.stats?.contacts || 0,
        open_reviews: workbench.stats?.open_reviews || 0,
        uploads: uploads.uploads?.length || 0,
        failed_scrapes: sourceRuns.filter((run: any) => ["failed", "timeout", "quota_blocked", "completed_with_errors"].includes(run.status)).length,
      },
      duplicate_properties: [],
      duplicate_deals: [],
      missing_parties: [],
      contact_gaps: workbench.contact_gaps || [],
      problem_runs: sourceRuns.filter((run: any) => ["requested", "running", "failed", "timeout", "quota_blocked", "completed_with_errors"].includes(run.status)),
      problem_uploads: (uploads.uploads || []).filter((upload: any) => ["failed", "resolving", "staged"].includes(upload.status)),
      runtime: health.runtime,
    });
  } catch (error: any) {
    return json({ error: "audit_failed", detail: error?.message || String(error) }, 500);
  }
};

export const config: Config = { path: "/api/admin/audit-live" };
