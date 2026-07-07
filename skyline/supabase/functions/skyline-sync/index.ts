// skyline-sync: pulls Deal entities from the Base44 dealflow app and upserts them
// into the Skyline Postgres tables (properties/entities/deals/deal_parties/contacts)
// via the sync_upsert_deals() RPC, which enforces every Skyline invariant.
// Scheduled by pg_cron after the nightly dealflow jobs. Auth: body.secret must
// match app_config('sync_secret') — fail-closed; Base44 creds from app_config.
// v4: shared plumbing (_shared/mod.ts), error boundary around the sync loop,
// ok=false when nothing synced and errors occurred.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {
  authorized, canonicalizeAddress, json, loadConfig, newTotals, normalizeEntity,
  serviceClient, upsertDeals,
} from "../_shared/mod.ts";

const supa = serviceClient();
const DEADLINE_MS = 140_000;

function mapSource(src: unknown): string {
  const s = String(src || "").toLowerCase();
  if (s.includes("acris")) return "acris";
  if (s.includes("traded")) return "traded";
  if (s.includes("crexi")) return "crexi";
  return "other";
}
// Sources emit junk like "December 1" (no year) and unpadded dates like 2026-6-8.
// Normalize what is normalizable; only genuinely undated rows pass through as null.
function isoDate(v: unknown): string | null {
  if (!v) return null;
  const m = String(v).match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!m) return null;
  const mo = Number(m[2]), d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${m[1]}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
function slim(r: Record<string, unknown>) {
  const addr = (r.address as string) || (r.normalized_address as string) || null;
  return {
    shortcode: r.shortcode || null,
    address: addr,
    address_norm: (r.normalized_address as string) || canonicalizeAddress(addr) || null,
    borough: r.borough || null,
    market: r.market || null,
    asset_type: r.asset_type || null,
    sale_price: r.sale_price ?? null,
    units: r.units ?? null,
    sqft: r.square_feet ?? null,
    sale_date: isoDate(r.sale_date),
    post_date: isoDate(r.post_date),
    source_system: mapSource(r.source),
    source_url: r.source_url || null,
    confidence: r.parse_confidence ?? null,
    parse_status: r.parse_status === "ok" ? "ok" : "needs_review",
    notes: r.notes || null,
    bbl: r.bbl || null,
    buyer: r.buyer || null,
    buyer_norm: (r.normalized_buyer as string) || normalizeEntity(r.buyer),
    seller: r.seller || null,
    seller_norm: (r.normalized_seller as string) || normalizeEntity(r.seller),
    buyer_address: r.buyer_address || null,
    seller_address: r.seller_address || null,
  };
}

Deno.serve(async (req: Request) => {
  const start = Date.now();
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* empty body ok */ }

  let conf: Record<string, string>;
  try {
    conf = await loadConfig(supa, ["base44_app_id", "base44_api_key", "sync_secret"]);
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
  if (!authorized(body.secret, conf.sync_secret)) return json({ error: "unauthorized" }, 401);

  const B44 = `https://app.base44.com/api/apps/${conf.base44_app_id}/entities/Deal`;
  const limit = typeof body.limit === "number" ? body.limit : Number.POSITIVE_INFINITY;
  let fetched = 0;
  const totals = newTotals();
  const errSamples: string[] = [];
  let hitDeadline = false;

  try {
    for (let page = 0; page < 60 && fetched < limit; page++) {
      if (Date.now() - start > DEADLINE_MS) { hitDeadline = true; break; }
      const res = await fetch(`${B44}?limit=500&skip=${page * 500}`, { headers: { api_key: conf.base44_api_key } });
      if (!res.ok) { errSamples.push(`base44 fetch ${res.status}`); break; }
      const rows = await res.json();
      if (!Array.isArray(rows) || rows.length === 0) break;
      const payload = rows.slice(0, Math.max(0, limit - fetched)).map(slim);
      fetched += payload.length;
      await upsertDeals(supa, payload, totals, errSamples);
      if (rows.length < 500) break;
    }
  } catch (e) {
    if (errSamples.length < 5) errSamples.push("sync loop: " + String(e));
  }

  // A run that fetched nothing and hit errors is a failure, not a green no-op.
  const ok = errSamples.length === 0 || fetched > 0;
  const summary = { ok, fetched, ...totals, error_samples: errSamples, hit_deadline: hitDeadline, elapsed_ms: Date.now() - start, at: new Date().toISOString() };
  const { error: stateErr } = await supa.from("sync_state")
    .upsert({ key: "base44_deals", value: summary, updated_at: new Date().toISOString() });
  if (stateErr) console.log("skyline-sync: sync_state write failed:", stateErr.message);
  console.log("skyline-sync:", JSON.stringify(summary));
  return json(summary);
});
