// api — the frontend's REST backend, implemented as a thin proxy over the
// PostgREST RPC layer (migration 004 api_* functions, whose JSON shapes were
// built to match these routes exactly). The deployed Netlify bundle calls
// VITE_API_URL = https://<ref>.supabase.co/functions/v1/api and hits
// /api/meta, /api/deals?…, etc. This function makes those routes real again.
// Public read surface (same data the anon RPC already exposes) → verify_jwt=false.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const JH = { ...CORS, "Content-Type": "application/json" };

const NUMERIC = new Set([
  "price_min", "price_max", "units_min", "units_max", "sqft_min", "sqft_max",
  "ppsf_max", "confidence_min", "page", "per_page", "min_deals", "lim", "top",
]);

// Allowed args per RPC — PostgREST rejects a call carrying an unknown named
// arg, so each endpoint whitelists exactly the params its function accepts.
const ALLOW: Record<string, Set<string>> = {
  api_deals: new Set(["q", "borough", "asset_type", "market", "price_min", "price_max",
    "date_min", "date_max", "units_min", "units_max", "sqft_min", "sqft_max",
    "ppsf_max", "confidence_min", "status", "has_buyer", "sort_by", "order_dir",
    "page", "per_page"]),
  api_buyers: new Set(["borough", "asset_type", "price_min", "price_max", "date_min",
    "min_deals", "rank_by", "lim"]),
  api_leaderboards: new Set(["group_by", "rank_by", "top"]),
  api_review: new Set(["status", "issue_class", "lim"]),
};

async function rpc(fn: string, args: Record<string, unknown>): Promise<Response> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  return new Response(await r.text(), { status: r.status, headers: JH });
}

function args(url: URL, fn: string, rename: Record<string, string> = {}): Record<string, unknown> {
  const allow = ALLOW[fn];
  const out: Record<string, unknown> = {};
  for (const [k0, v] of url.searchParams.entries()) {
    if (v === "" || v == null) continue;
    const k = rename[k0] ?? k0;
    if (allow && !allow.has(k)) continue;
    if (NUMERIC.has(k)) { const n = Number(v); if (Number.isNaN(n)) continue; out[k] = n; }
    else if (k === "has_buyer") out[k] = v === "true" || v === "1";
    else out[k] = v;
  }
  return out;
}

const backendOnly = (msg: string) =>
  new Response(JSON.stringify({ error: msg }), { headers: JH });

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const url = new URL(req.url);
  let p = url.pathname;
  const marker = "/functions/v1/api";
  const i = p.indexOf(marker);
  if (i >= 0) p = p.slice(i + marker.length);
  if (!p.startsWith("/")) p = "/" + p;
  p = p.replace(/\/+$/, "") || "/";

  try {
    if (p === "/api/health" || p === "/health" || p === "/") return await rpc("api_health", {});
    if (p === "/api/meta" || p === "/meta") return await rpc("api_meta", {});
    if (p === "/api/deals" || p === "/deals")
      return await rpc("api_deals", args(url, "api_deals", { sort: "sort_by", order: "order_dir" }));
    if (p === "/api/buyers" || p === "/buyers")
      return await rpc("api_buyers", args(url, "api_buyers", { limit: "lim" }));
    if (p === "/api/leaderboards" || p === "/leaderboards")
      return await rpc("api_leaderboards", args(url, "api_leaderboards"));
    if (p === "/api/uploads" || p === "/uploads")
      return await rpc("api_uploads_list", {});
    if (p === "/api/review" || p === "/review")
      return await rpc("api_review", args(url, "api_review", { limit: "lim" }));

    const em = p.match(/\/entities\/([^/]+)$/);
    if (em) return await rpc("api_entity", { eid: decodeURIComponent(em[1]) });

    if ((p === "/api/review/act" || p === "/review/act") && req.method === "POST") {
      const b = await req.json().catch(() => ({}));
      return await rpc("api_review_act", { review_id: b.review_id, action: b.action, user_id: b.user_id ?? "web" });
    }
    // These need the Python backend; degrade honestly (the frontend handles error).
    if (p === "/api/agent" || p === "/agent")
      return new Response(JSON.stringify({
        error: "no_ai_provider_available",
        detail: "The Deal Desk runs on the FastAPI backend, which is not deployed.",
        hint: "The data tabs work; deploy the backend to enable the AI agent.",
      }), { headers: JH });
    if (p === "/api/uploads/resolve" || p === "/uploads/resolve")
      return backendOnly("Uploads require the FastAPI backend, which is not deployed.");

    return new Response(JSON.stringify({ error: "not found", path: p }), { status: 404, headers: JH });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: JH });
  }
});
