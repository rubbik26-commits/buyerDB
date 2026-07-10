import { getEnv, invokeEdge, rpc, updateRun, type Json } from "./supabase.mts";
import { runRolling } from "./rolling.mts";
import { runPhase2 } from "./phase2.mts";
import { runCrexi } from "./crexi.mts";

export async function runScraperJob(job: string, runId: string, options: Json = {}) {
  await updateRun(runId, "running", { stage: "started", runtime: "netlify-background" });
  try {
    let result: Json;
    if (job === "acris_refresh") {
      result = await invokeEdge("sbi-acris-refresh", { run_id: runId, limit: Number(options.limit || 500), days: Number(options.days || 120) });
    } else if (job === "traded_refresh") {
      const key = getEnv("SCRAPERAPI_KEY");
      if (!key) {
        await updateRun(runId, "quota_blocked", {}, "SCRAPERAPI_KEY is not configured");
        return { ok: false, status: "quota_blocked", error: "SCRAPERAPI_KEY is not configured" };
      }
      result = await invokeEdge("sbi-traded-refresh", { run_id: runId, max_fetches: Number(options.max_fetches || 50) }, { "x-scraperapi-key": key });
    } else if (job === "rolling_sales") {
      result = await runRolling(options);
      await updateRun(runId, result.fetch_errors ? "completed_with_errors" : "completed", result, result.fetch_errors ? `${result.fetch_errors} fetch errors` : null);
    } else if (job === "phase2_enrichment") {
      result = await runPhase2(options);
      await updateRun(runId, result.fetch_errors ? "completed_with_errors" : "completed", result, result.fetch_errors ? `${result.fetch_errors} fetch errors` : null);
    } else if (job === "dos_enrich") {
      result = await invokeEdge("sbi-dos-enrich", { limit: Number(options.limit || 400) });
      await updateRun(runId, result.ok === false ? "completed_with_errors" : "completed", result, result.error || null);
    } else if (job === "property_owner_refresh") {
      const phase2 = await runPhase2(options);
      const dos = await invokeEdge("sbi-dos-enrich", { limit: Number(options.dos_limit || 400) });
      result = { phase2, dos };
      await updateRun(runId, phase2.fetch_errors || dos.ok === false ? "completed_with_errors" : "completed", result, null);
    } else if (job === "crexi_refresh") {
      result = await runCrexi(options);
      await updateRun(runId, result.status || "completed", result, result.error || null);
    } else {
      throw new Error(`Unsupported background scraper job: ${job}`);
    }
    return { ok: result?.ok !== false && !result?.error, job, run_id: runId, result };
  } catch (error) {
    await updateRun(runId, "failed", { runtime: "netlify-background" }, String(error));
    throw error;
  }
}

export async function createRequestedRun(job: string, userId = "broker", options: Json = {}) {
  return rpc("api_request_scrape", { job, user_id: userId, options });
}

export function triggerSecret() {
  return getEnv("SCRAPER_TRIGGER_SECRET") || getEnv("SYNC_SECRET") || getEnv("CRON_SECRET") || getEnv("SUPABASE_JWT_SECRET");
}
