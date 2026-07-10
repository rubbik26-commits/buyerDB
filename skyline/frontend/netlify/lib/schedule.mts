import { getEnv } from "./supabase.mts";
import { triggerSecret } from "./orchestrator.mts";

export async function triggerScheduled(job: string, options: Record<string, unknown> = {}) {
  const site = (getEnv("URL") || getEnv("FRONTEND_URL") || "https://buyerdb.netlify.app").replace(/\/$/, "");
  const secret = triggerSecret();
  if (!secret) throw new Error("SCRAPER_TRIGGER_SECRET is not configured.");
  const response = await fetch(`${site}/api/scrapers/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-scraper-trigger-secret": secret },
    body: JSON.stringify({ job, user_id: "netlify-scheduler", options }),
  });
  if (!response.ok && response.status !== 202) throw new Error(`${job} dispatch HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  console.log(job, await response.text());
}
