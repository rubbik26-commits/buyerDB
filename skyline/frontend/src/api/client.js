const BASE = import.meta.env.VITE_API_URL || "http://localhost:8000";

// Two transports, one api surface:
//  * legacy mode — a FastAPI backend serving /api/* (localhost or Render/Railway)
//  * rpc mode    — Supabase's PostgREST gateway calling the api_* SQL functions
//    (migration 004), used while no backend host exists. Detected by the URL.
const RPC_MODE = BASE.includes(".supabase.co");
const SUPA = RPC_MODE ? new URL(BASE).origin : null;
const ANON = import.meta.env.VITE_SUPABASE_ANON_KEY || "";

const NEEDS_BACKEND =
  "This feature runs on the FastAPI backend, which is not deployed yet. " +
  "The data tabs are served directly from the database; deploy the backend " +
  "(render.yaml in the repo) to enable uploads, entity merges, AI Deal Desk, " +
  "property owner workflows, scraper requests, and broker worklists.";

// surface the response body on failure — PostgREST/FastAPI put the actual
// reason there, and "HTTP 400" alone is undebuggable
async function fail(label, r) {
  let detail = "";
  try { detail = (await r.text()).slice(0, 300); } catch { /* body unreadable */ }
  throw new Error(`${label} → HTTP ${r.status}${detail ? ` — ${detail}` : ""}`);
}

async function rpc(fn, args) {
  if (!ANON) throw new Error("VITE_SUPABASE_ANON_KEY is required for Supabase RPC mode.");
  const r = await fetch(`${SUPA}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      apikey: ANON,
      Authorization: `Bearer ${ANON}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args || {}),
  });
  if (!r.ok) await fail(fn, r);
  return r.json();
}

// drop empty values; coerce numeric strings so SQL arg types line up.
// "$3,000,000" must become 3000000, and anything unparseable is DROPPED —
// NaN serializes to null, which SQL reads as "no filter": the user would see
// unfiltered results while believing they filtered.
function clean(params, numeric = []) {
  const out = {};
  Object.entries(params || {}).forEach(([k, v]) => {
    if (v === undefined || v === null || v === "") return;
    if (numeric.includes(k)) {
      const n = Number(String(v).replace(/[$,\s]/g, ""));
      if (Number.isNaN(n)) return;
      out[k] = n;
    } else {
      out[k] = v;
    }
  });
  return out;
}

async function get(path, params) {
  const url = new URL(BASE + path);
  if (params) {
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
    });
  }
  const r = await fetch(url);
  if (!r.ok) await fail(path, r);
  return r.json();
}

async function post(path, body) {
  const r = await fetch(BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) await fail(path, r);
  return r.json();
}

const legacy = {
  base: BASE,
  meta: () => get("/api/meta"),
  health: () => get("/api/health"),
  deals: (params) => get("/api/deals", params),
  buyers: (params) => get("/api/buyers", params),
  leaderboards: (params) => get("/api/leaderboards", params),
  entity: (id) => get(`/api/entities/${id}`),
  agent: (question, history) => post("/api/agent", { question, history }),
  uploads: () => get("/api/uploads"),
  resolveUpload: (body) => post("/api/uploads/resolve", body),
  review: (params) => get("/api/review", params),
  reviewAct: (body) => post("/api/review/act", body),
  workbench: () => get("/api/workbench"),
  properties: (params) => get("/api/properties", params),
  tasks: (params) => get("/api/tasks", params),
  logInteraction: (body) => post("/api/interactions", body),
  scraperRuns: (params) => get("/api/scrapers/runs", params),
  requestScrape: (body) => post("/api/scrapers/request", body),
  async uploadFile(file, userId = "broker") {
    const fd = new FormData();
    fd.append("file", file);
    fd.append("user_id", userId);
    const r = await fetch(BASE + "/api/uploads", { method: "POST", body: fd });
    if (!r.ok) throw new Error(`upload → HTTP ${r.status}`);
    return r.json();
  },
};

const NUMERIC_DEAL_ARGS = ["price_min", "price_max", "units_min", "units_max",
  "sqft_min", "sqft_max", "ppsf_max", "confidence_min", "page", "per_page"];

const rpcBackendRequired = async () => ({ error: NEEDS_BACKEND, hint: NEEDS_BACKEND });

const rpcApi = {
  base: BASE,
  meta: () => rpc("api_meta", {}),
  health: () => rpc("api_health", {}),
  deals: ({ sort, order, has_buyer, ...rest } = {}) =>
    rpc("api_deals", {
      ...clean(rest, NUMERIC_DEAL_ARGS),
      has_buyer: has_buyer === true || has_buyer === "true",
      ...(sort ? { sort_by: sort } : {}),
      ...(order ? { order_dir: order } : {}),
    }),
  buyers: ({ limit, ...rest } = {}) =>
    rpc("api_buyers", {
      ...clean(rest, ["price_min", "price_max", "min_deals"]),
      ...(limit ? { lim: Number(limit) } : {}),
    }),
  leaderboards: (params) => rpc("api_leaderboards", clean(params, ["top"])),
  entity: (id) => rpc("api_entity", { eid: id }),
  agent: async () => ({
    error: "no_ai_provider_available",
    detail: "The Deal Desk runs on the FastAPI backend, which is not deployed yet.",
    hint: NEEDS_BACKEND,
  }),
  uploads: () => rpc("api_uploads_list", {}),
  resolveUpload: async () => ({ error: NEEDS_BACKEND }),
  review: ({ limit, ...rest } = {}) =>
    rpc("api_review", { ...clean(rest), ...(limit ? { lim: Number(limit) } : {}) }),
  reviewAct: async ({ review_id, action, user_id }) => {
    if (action === "confirm_merge") {
      // entity merges run Python entity-resolution — the RPC layer deliberately
      // has no write path for them
      throw new Error(NEEDS_BACKEND);
    }
    const res = await rpc("api_review_act", { review_id, action, user_id });
    if (res && res.error) throw new Error(res.error);
    return res;
  },
  workbench: rpcBackendRequired,
  properties: rpcBackendRequired,
  tasks: rpcBackendRequired,
  logInteraction: rpcBackendRequired,
  scraperRuns: rpcBackendRequired,
  requestScrape: rpcBackendRequired,
  uploadFile: async () => ({ error: NEEDS_BACKEND }),
};

export const api = RPC_MODE ? rpcApi : legacy;
// true when the app talks straight to Supabase (no backend): views use this to
// hide actions that can never succeed in this mode
export const IS_RPC_MODE = RPC_MODE;

export function money(n, compact = false) {
  if (n === null || n === undefined) return "—";
  const v = Number(n);
  if (compact) {
    if (v >= 1e9) return "$" + (v / 1e9).toFixed(2) + "B";
    if (v >= 1e6) return "$" + (v / 1e6).toFixed(1) + "M";
    if (v >= 1e3) return "$" + Math.round(v / 1e3) + "K";
  }
  return "$" + v.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

export function num(n) {
  if (n === null || n === undefined) return "—";
  return Number(n).toLocaleString("en-US", { maximumFractionDigits: 0 });
}

export function shortDate(d) {
  if (!d) return "—";
  return String(d).slice(0, 10);
}
