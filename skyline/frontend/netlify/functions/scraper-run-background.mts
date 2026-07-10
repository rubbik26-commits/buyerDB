import type { Config, Context } from "@netlify/functions";
import { runScraperJob, triggerSecret } from "../lib/orchestrator.mts";

export default async (req: Request, _context: Context) => {
  const expected = triggerSecret();
  if (!expected || req.headers.get("x-scraper-trigger-secret") !== expected) {
    console.log("scraper background request rejected");
    return;
  }
  let body: any = {};
  try { body = await req.json(); } catch { console.log("invalid scraper background body"); return; }
  const job = String(body.job || "");
  const runId = String(body.run_id || "");
  if (!job || !runId) { console.log("scraper background job/run_id missing"); return; }
  try {
    const result = await runScraperJob(job, runId, body.options || {});
    console.log("scraper background complete", JSON.stringify(result));
  } catch (error) {
    console.log("scraper background failed", job, runId, String(error));
  }
};

export const config: Config = { path: "/api/scrapers/run-background" };
