// skyline-sync: pulls Deal entities from the Base44 dealflow app and upserts them
// into the Skyline Postgres tables (properties/entities/deals/deal_parties/contacts)
// via the sync_upsert_deals() RPC, which enforces every Skyline invariant.
// Scheduled by pg_cron after the nightly dealflow jobs. Auth: body.secret must
// match app_config('sync_secret'); Base44 creds come from app_config, not source.
// Deployed 2026-07-06 (v3) — this file mirrors production.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const supa = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);
const DEADLINE_MS = 140_000;

const SUFFIX: Record<string, string> = { STREET: "ST", ST: "ST", STR: "ST", AVENUE: "AVE", AVE: "AVE", AV: "AVE", BOULEVARD: "BLVD", BLVD: "BLVD", ROAD: "RD", RD: "RD", DRIVE: "DR", DR: "DR", LANE: "LN", LN: "LN", COURT: "CT", CT: "CT", PLACE: "PL", PL: "PL", PLAZA: "PLZ", TERRACE: "TER", PARKWAY: "PKWY", HIGHWAY: "HWY", EXPRESSWAY: "EXPY", SQUARE: "SQ", CIRCLE: "CIR", TURNPIKE: "TPKE" };
const DIR: Record<string, string> = { EAST: "E", WEST: "W", NORTH: "N", SOUTH: "S" };
function canon(raw: unknown): string {
  if (!raw || typeof raw !== "string") return "";
  let a = raw.trim().toUpperCase().replace(/[.,;:()]/g, " ")
    .replace(/\s+\d{5}(-\d{4})?$/, "")
    .replace(/\s+(NY|NYC|NEW YORK|MANHATTAN|BROOKLYN|QUEENS|BRONX|STATEN ISLAND)$/g, "")
    .replace(/\s+/g, " ").trim();
  if (!a) return "";
  return a.split(" ").map((t) => DIR[t] || SUFFIX[t] || t).join(" ").trim();
}
function normEnt(name: unknown): string | null {
  if (!name || typeof name !== "string" || !name.trim()) return null;
  return name.trim().toUpperCase()
    .replace(/L\.L\.C\.|LLC/gi, "LLC").replace(/INC\.|INCORPORATED|INC/gi, "INC")
    .replace(/\s+/g, " ").trim() || null;
}
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
    address_norm: (r.normalized_address as string) || canon(addr) || null,
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
    buyer_norm: (r.normalized_buyer as string) || normEnt(r.buyer),
    seller: r.seller || null,
    seller_norm: (r.normalized_seller as string) || normEnt(r.seller),
    buyer_address: r.buyer_address || null,
    seller_address: r.seller_address || null,
    buyer_phone: r.buyer_phone || null,
    buyer_email: r.buyer_email || null,
    seller_phone: r.seller_phone || null,
    seller_email: r.seller_email || null,
  };
}

Deno.serve(async (req: Request) => {
  const start = Date.now();
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* empty body ok */ }

  const { data: cfg, error: cfgErr } = await supa.from("app_config")
    .select("key,value").in("key", ["base44_app_id", "base44_api_key", "sync_secret"]);
  if (cfgErr) return new Response(JSON.stringify({ ok: false, error: "config: " + cfgErr.message }), { status: 500, headers: { "Content-Type": "application/json" } });
  const conf = Object.fromEntries((cfg ?? []).map((r) => [r.key, r.value]));
  if (body.secret !== conf.sync_secret) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
  }

  const B44 = `https://app.base44.com/api/apps/${conf.base44_app_id}/entities/Deal`;
  const limit = typeof body.limit === "number" ? body.limit : Number.POSITIVE_INFINITY;
  let fetched = 0;
  const totals: Record<string, number> = { inserted: 0, dup: 0, skipped_residential: 0, skipped_invalid: 0, parties: 0, contacts: 0, errors: 0 };
  const errSamples: string[] = [];
  let hitDeadline = false;

  for (let page = 0; page < 60; page++) {
    if (Date.now() - start > DEADLINE_MS) { hitDeadline = true; break; }
    const res = await fetch(`${B44}?limit=500&skip=${page * 500}`, { headers: { api_key: conf.base44_api_key as string } });
    if (!res.ok) { errSamples.push(`base44 fetch ${res.status}`); break; }
    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length === 0) break;
    const payload = rows.slice(0, Math.max(0, limit - fetched)).map(slim);
    fetched += payload.length;
    const { data, error } = await supa.rpc("sync_upsert_deals", { rows: payload });
    if (error) { totals.errors += payload.length; if (errSamples.length < 5) errSamples.push("rpc: " + error.message); }
    else if (data) {
      for (const k of Object.keys(totals)) totals[k] += Number(data[k] ?? 0);
      for (const s of (data.error_samples ?? [])) if (errSamples.length < 5) errSamples.push(String(s));
    }
    if (rows.length < 500 || fetched >= limit) break;
  }

  const summary = { ok: true, fetched, ...totals, error_samples: errSamples, hit_deadline: hitDeadline, elapsed_ms: Date.now() - start, at: new Date().toISOString() };
  await supa.from("sync_state").upsert({ key: "base44_deals", value: summary, updated_at: new Date().toISOString() });
  console.log("skyline-sync:", JSON.stringify(summary));
  return new Response(JSON.stringify(summary), { headers: { "Content-Type": "application/json" } });
});
