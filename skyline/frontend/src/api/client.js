const BASE = import.meta.env.VITE_API_URL || "http://localhost:8000";

// Two transports, one api surface:
//  * legacy mode — a FastAPI backend serving /api/* (localhost or Render/Railway)
//  * rpc mode    — Supabase's PostgREST gateway calling the api_* SQL functions
//    (migrations 004 and 010), used while no backend host exists.
const RPC_MODE = BASE.includes(".supabase.co");
const SUPA = RPC_MODE ? new URL(BASE).origin : null;
const ANON = import.meta.env.VITE_SUPABASE_ANON_KEY || "";

const NEEDS_BACKEND =
  "The AI Deal Desk provider router and confirm-merge entity resolution still require the optional FastAPI backend. The database tabs, workbench, owner workflow, tasks, scraper requests, review resolve/dismiss, and CSV contact upload now run in Supabase RPC mode.";

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

function parseCsv(text) {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
  const split = (line) => {
    const out = []; let cur = ""; let q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i], next = line[i + 1];
      if (q) {
        if (ch === '"' && next === '"') { cur += '"'; i++; }
        else if (ch === '"') q = false;
        else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === ",") { out.push(cur); cur = ""; }
      else cur += ch;
    }
    out.push(cur);
    return out;
  };
  const headers = split(lines.shift() || "").map((h) => h.trim());
  return lines.map((line) => Object.fromEntries(split(line).map((v, i) => [headers[i], v ?? ""])));
}

function sniffMapping(columns) {
  const aliases = {
    entity_name: ["owner", "entity", "company", "name", "buyer", "seller"],
    person_name: ["contact", "contact_name", "person", "principal"],
    phone: ["phone", "tel", "mobile", "cell"],
    email: ["email", "e-mail"],
    mailing_address: ["mailing", "mailing_address", "address"],
    title: ["title", "role"],
    interaction_notes: ["notes", "comments", "remarks"],
    channel: ["channel", "method"],
  };
  const out = {};
  for (const col of columns) {
    const key = String(col).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
    for (const [field, names] of Object.entries(aliases)) {
      if (key === field || names.includes(key)) { out[col] = field; break; }
    }
  }
  return out;
}

async function uploadCsvViaRpc(file, userId = "broker") {
  if (!file.name.toLowerCase().endsWith(".csv")) throw new Error("Supabase RPC mode supports CSV contact imports. Excel imports require the optional FastAPI backend.");
  const rows = parseCsv(await file.text());
  const columns = rows[0] ? Object.keys(rows[0]) : [];
  const mapping = sniffMapping(columns);
  return rpc("api_upload_stage", { filename: file.name, user_id: userId, rows, columns, mapping });
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

const NUMERIC_DEAL_ARGS = ["price_min", "price_max", "units_min", "units_max", "sqft_min", "sqft_max", "ppsf_max", "confidence_min", "page", "per_page"];

const rpcApi = {
  base: BASE,
  meta: () => rpc("api_meta", {}),
  health: () => rpc("api_health", {}),
  deals: ({ sort, order, has_buyer, ...rest } = {}) => rpc("api_deals", { ...clean(rest, NUMERIC_DEAL_ARGS), has_buyer: has_buyer === true || has_buyer === "true", ...(sort ? { sort_by: sort } : {}), ...(order ? { order_dir: order } : {}) }),
  buyers: ({ limit, ...rest } = {}) => rpc("api_buyers", { ...clean(rest, ["price_min", "price_max", "min_deals"]), ...(limit ? { lim: Number(limit) } : {}) }),
  leaderboards: (params) => rpc("api_leaderboards", clean(params, ["top"])),
  entity: (id) => rpc("api_entity", { eid: id }),
  agent: async () => ({ error: "backend_required_for_ai_agent", detail: "The AI Deal Desk provider router still requires the optional FastAPI backend.", hint: NEEDS_BACKEND }),
  uploads: () => rpc("api_uploads_list", {}),
  uploadFile: uploadCsvViaRpc,
  resolveUpload: ({ upload_id, mapping, user_id } = {}) => rpc("api_upload_resolve", { upload_id, mapping, user_id }),
  review: ({ limit, ...rest } = {}) => rpc("api_review", { ...clean(rest), ...(limit ? { lim: Number(limit) } : {}) }),
  reviewAct: async ({ review_id, action, user_id }) => {
    if (action === "confirm_merge") throw new Error(NEEDS_BACKEND);
    const res = await rpc("api_review_act", { review_id, action, user_id });
    if (res && res.error) throw new Error(res.error);
    return res;
  },
  workbench: () => rpc("api_workbench", {}),
  properties: ({ contact_gap, page, per_page, ...rest } = {}) => rpc("api_properties", { ...clean(rest), contact_gap: contact_gap === true || contact_gap === "true", ...(page ? { page: Number(page) } : {}), ...(per_page ? { per_page: Number(per_page) } : {}) }),
  tasks: ({ limit } = {}) => rpc("api_tasks", { ...(limit ? { lim: Number(limit) } : {}) }),
  logInteraction: ({ entity_id, channel, subject, notes, outcome, user_id } = {}) => rpc("api_log_interaction", { entity_id, channel, subject, notes, outcome, user_id }),
  scraperRuns: ({ limit } = {}) => rpc("api_scraper_runs", { ...(limit ? { lim: Number(limit) } : {}) }),
  requestScrape: ({ job, user_id, options } = {}) => rpc("api_request_scrape", { job, user_id, options }),
};

export const api = RPC_MODE ? rpcApi : legacy;
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
