import type { Config, Context } from "@netlify/functions";
import { createRequestedRun, triggerSecret } from "../lib/orchestrator.mts";
import { getEnv, runtimeRpc } from "../lib/supabase.mts";

const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
const JOBS = new Set(["traded_refresh", "acris_refresh", "crexi_refresh", "property_owner_refresh", "rolling_sales", "phase2_enrichment", "dos_enrich", "full_refresh"]);

async function dispatch(job: string, userId: string, options: Record<string, unknown>) {
  const recent = await runtimeRpc("sbi_runtime_active_run", { p_job: job, p_minutes: 30 });
  if (recent?.run_id) return { ...recent, deduplicated: true };
  const requested = await createRequestedRun(job, userId, options);
  if (!requested?.run_id) throw new Error(requested?.error || `Unable to create ${job} run row.`);
  const site = getEnv("URL") || getEnv("FRONTEND_URL") || "https://buyerdb.netlify.app";
  const secret = triggerSecret();
  if (!secret) throw new Error("The scheduler credential is not configured.");
  const response = await fetch(`${site.replace(/\/$/, "")}/api/scrapers/run-background`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-scraper-trigger-secret": secret },
    body: JSON.stringify({ job, run_id: requested.run_id, options }),
  });
  if (!response.ok && response.status !== 202) throw new Error(`Background dispatch returned HTTP ${response.status}.`);
  return { ...requested, dispatched: true };
}

export default async (req: Request, _context: Context) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const site = (getEnv("URL") || getEnv("FRONTEND_URL") || "https://buyerdb.netlify.app").replace(/\/$/, "");
  const browserRequest = req.headers.get("origin") === site;
  const scheduledRequest = Boolean(triggerSecret() && req.headers.get("x-scraper-trigger-secret") === triggerSecret());
  if (!browserRequest && !scheduledRequest) return json({ error: "request_not_allowed" }, 403);
  let body: any = {};
  try { body = await req.json(); } catch { return json({ error: "invalid_json" }, 400); }
  const requestedJob = String(body.job || "full_refresh");
  if (!JOBS.has(requestedJob)) return json({ error: "unsupported_job", job: requestedJob }, 400);
  const userId = String(body.user_id || "broker");
  const options = body.options && typeof body.options === "object" ? body.options : {};
  try {
    const jobs = requestedJob === "full_refresh" ? ["acris_refresh", "traded_refresh", "crexi_refresh", "rolling_sales", "property_owner_refresh"] : [requestedJob];
    const runs = [];
    for (const job of jobs) runs.push(await dispatch(job, userId, options));
    return json({ status: "dispatched", requested_job: requestedJob, runs }, 202);
  } catch (error: any) {
    return json({ error: "scraper_dispatch_failed", detail: error?.message || String(error) }, 500);
  }
};

export const config: Config = { path: "/api/scrapers/run" };
