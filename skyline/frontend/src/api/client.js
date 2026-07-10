const RAW_BASE = import.meta.env.VITE_API_URL || "";
const ANON = import.meta.env.VITE_SUPABASE_ANON_KEY || "";
const SUPABASE_BASE = RAW_BASE.includes(".supabase.co") ? new URL(RAW_BASE).origin : null;
const RPC_MODE = Boolean(SUPABASE_BASE && ANON && import.meta.env.VITE_USE_SUPABASE_RPC === "true");
const BASE = RPC_MODE ? "" : (SUPABASE_BASE ? "" : (RAW_BASE || "http://localhost:8000"));
const SUPA = RPC_MODE ? SUPABASE_BASE : null;

async function fail(label, response) {
  let detail = "";
  try { detail = (await response.text()).slice(0, 500); } catch {}
  throw new Error(`${label} → HTTP ${response.status}${detail ? ` — ${detail}` : ""}`);
}

async function rpc(fn, args = {}) {
  if (!ANON || !SUPA) throw new Error("The Supabase publishable key is missing from the frontend build.");
  const response = await fetch(`${SUPA}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  if (!response.ok) await fail(fn, response);
  return response.json();
}

function apiUrl(path) {
  return BASE ? new URL(BASE + path, window.location.origin) : new URL(path, window.location.origin);
}
async function get(path, params) {
  const url = apiUrl(path);
  Object.entries(params || {}).forEach(([key, value]) => { if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, value); });
  const response = await fetch(url);
  if (!response.ok) await fail(path, response);
  return response.json();
}
async function post(path, body = {}) {
  const response = await fetch(apiUrl(path), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok) await fail(path, response);
  return response.json();
}
async function del(path, params = {}) {
  const url = apiUrl(path);
  Object.entries(params).forEach(([key, value]) => { if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, value); });
  const response = await fetch(url, { method: "DELETE" });
  if (!response.ok) await fail(path, response);
  return response.json();
}

function clean(params, numeric = []) {
  const out = {};
  Object.entries(params || {}).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "") return;
    if (numeric.includes(key)) {
      const number = Number(String(value).replace(/[$,\s]/g, ""));
      if (!Number.isNaN(number)) out[key] = number;
    } else out[key] = value;
  });
  return out;
}

function parseCsv(text) {
  const rows = [];
  let row = [], value = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i], next = text[i + 1];
    if (quoted) {
      if (char === '"' && next === '"') { value += '"'; i++; }
      else if (char === '"') quoted = false;
      else value += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") { row.push(value); value = ""; }
    else if (char === "\n") { row.push(value); rows.push(row); row = []; value = ""; }
    else if (char !== "\r") value += char;
  }
  row.push(value);
  if (row.length > 1 || row[0]) rows.push(row);
  const headers = (rows.shift() || []).map(header => header.trim());
  return rows.filter(values => values.some(Boolean)).map(values => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])));
}
function sniffMapping(columns) {
  const aliases = {
    entity_name: ["owner", "entity", "company", "name", "buyer", "seller"],
    person_name: ["contact", "contact_name", "person", "principal"],
    phone: ["phone", "tel", "mobile", "cell"], email: ["email", "e-mail"],
    mailing_address: ["mailing", "mailing_address", "address"], title: ["title", "role"],
    last_contact_date: ["last_contact", "last_contacted"], interaction_notes: ["notes", "comments", "remarks"],
    channel: ["channel", "method"], deal_address: ["property_address", "deal_address", "address", "property", "site"],
    borough: ["borough", "boro"], market: ["market", "neighborhood", "submarket"],
    sale_date: ["sale_date", "closing_date", "transaction_date", "date"], post_date: ["post_date", "posted"],
    asset_type: ["asset_type", "property_type", "type"], sale_price: ["sale_price", "price", "amount", "consideration"],
    units: ["units"], sqft: ["sqft", "sf", "square_feet"], source_url: ["source_url", "url", "link"],
    shortcode: ["shortcode", "slug"], buyer_name: ["buyer", "buyer_name", "purchaser"], seller_name: ["seller", "seller_name", "grantor"],
  };
  const mapping = {};
  for (const column of columns) {
    const normalized = String(column).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
    for (const [field, names] of Object.entries(aliases)) if (normalized === field || names.includes(normalized)) { mapping[column] = field; break; }
  }
  return mapping;
}
async function uploadCsvViaRpc(file, userId = "broker") {
  if (!file.name.toLowerCase().endsWith(".csv")) throw new Error("CSV is supported in direct RPC mode. Excel files use the server upload endpoint.");
  const rows = parseCsv(await file.text());
  const columns = rows[0] ? Object.keys(rows[0]) : [];
  return rpc("api_upload_stage", { filename: file.name, user_id: userId, rows, columns, mapping: sniffMapping(columns) });
}

const NUMERIC_DEAL_ARGS = ["price_min", "price_max", "units_min", "units_max", "sqft_min", "sqft_max", "ppsf_max", "confidence_min", "page", "per_page"];

const legacy = {
  base: BASE || window.location.origin,
  meta: () => get("/api/meta"), health: () => get("/api/health"), deals: params => get("/api/deals", params),
  buyers: params => get("/api/buyers", params), leaderboards: params => get("/api/leaderboards", params),
  entity: id => get(`/api/entities/${id}`), agent: (question, history) => post("/api/agent", { question, history }),
  uploads: () => get("/api/uploads"), resolveUpload: body => post("/api/uploads/resolve", body),
  review: params => get("/api/review", params), reviewAct: body => post("/api/review/act", body),
  workbench: () => get("/api/workbench"), properties: params => get("/api/properties", params), tasks: params => get("/api/tasks", params),
  logInteraction: body => post("/api/interactions", body), scraperRuns: params => get("/api/scrapers/runs", params),
  requestScrape: body => post("/api/scrapers/run", body), audit: () => get("/api/admin/audit"), fixStaleRuns: () => post("/api/admin/fix-stale-runs", {}),
  outreachTargets: params => get("/api/outreach/targets", params), outreachDraft: body => post("/api/outreach/draft", body),
  savedViews: params => get("/api/saved-views", params), saveView: body => post("/api/saved-views", body),
  deleteView: (viewId, userId = "broker") => del(`/api/saved-views/${viewId}`, { user_id: userId }), propertyMap: params => get("/api/property-map", params),
  async uploadFile(file, userId = "broker") { const form = new FormData(); form.append("file", file); form.append("user_id", userId); const response = await fetch(apiUrl("/api/uploads"), { method: "POST", body: form }); if (!response.ok) await fail("upload", response); return response.json(); },
};

const rpcApi = {
  base: "",
  meta: () => rpc("api_meta"), health: () => rpc("api_health"),
  deals: ({ sort, order, has_buyer, ...rest } = {}) => rpc("api_deals", { ...clean(rest, NUMERIC_DEAL_ARGS), has_buyer: has_buyer === true || has_buyer === "true", ...(sort ? { sort_by: sort } : {}), ...(order ? { order_dir: order } : {}) }),
  buyers: ({ limit, ...rest } = {}) => rpc("api_buyers", { ...clean(rest, ["price_min", "price_max", "min_deals"]), ...(limit ? { lim: Number(limit) } : {}) }),
  leaderboards: params => rpc("api_leaderboards", clean(params, ["top"])), entity: id => rpc("api_entity", { eid: id }),
  agent: (question, history) => post("/api/agent", { question, history }),
  uploads: () => rpc("api_uploads_list"), uploadFile: uploadCsvViaRpc,
  resolveUpload: ({ upload_id, mapping, user_id } = {}) => rpc("api_upload_resolve", { upload_id, mapping, user_id }),
  review: ({ limit, ...rest } = {}) => rpc("api_review", { ...clean(rest), ...(limit ? { lim: Number(limit) } : {}) }),
  reviewAct: async ({ review_id, action, entity_id, user_id }) => { const result = await rpc("api_review_act", { review_id, action, entity_id: entity_id || null, user_id }); if (result?.error) throw new Error(result.error); return result; },
  workbench: () => rpc("api_workbench"),
  properties: ({ contact_gap, page, per_page, ...rest } = {}) => rpc("api_properties", { ...clean(rest), contact_gap: contact_gap === true || contact_gap === "true", ...(page ? { page: Number(page) } : {}), ...(per_page ? { per_page: Number(per_page) } : {}) }),
  tasks: ({ limit } = {}) => rpc("api_tasks", { ...(limit ? { lim: Number(limit) } : {}) }),
  logInteraction: ({ entity_id, channel, subject, notes, outcome, user_id } = {}) => rpc("api_log_interaction", { entity_id, channel, subject, notes, outcome, user_id }),
  scraperRuns: ({ limit } = {}) => rpc("api_scraper_runs", { ...(limit ? { lim: Number(limit) } : {}) }),
  requestScrape: body => post("/api/scrapers/run", body),
  audit: () => post("/api/admin/audit-live", {}), fixStaleRuns: () => rpc("api_fix_stale_runs"),
  outreachTargets: params => post("/api/outreach/targets", params || {}), outreachDraft: body => rpc("api_outreach_draft", body),
  savedViews: ({ user_id = "broker", surface } = {}) => rpc("api_saved_views", { user_id, surface: surface || null }),
  saveView: ({ user_id = "broker", name, surface, filters = {}, sort = {} } = {}) => rpc("api_save_view", { user_id, name, surface, filters, sort }),
  deleteView: (viewId, userId = "broker") => rpc("api_delete_view", { view_id: viewId, user_id: userId }),
  propertyMap: ({ limit } = {}) => rpc("api_property_map", { lim: Number(limit || 1000) }),
};

export const api = RPC_MODE ? rpcApi : legacy;
export const IS_RPC_MODE = RPC_MODE;
export function money(n, compact = false) { if (n === null || n === undefined) return "—"; const value = Number(n); if (compact) { if (value >= 1e9) return "$" + (value / 1e9).toFixed(2) + "B"; if (value >= 1e6) return "$" + (value / 1e6).toFixed(1) + "M"; if (value >= 1e3) return "$" + Math.round(value / 1e3) + "K"; } return "$" + value.toLocaleString("en-US", { maximumFractionDigits: 0 }); }
export function num(n) { if (n === null || n === undefined) return "—"; return Number(n).toLocaleString("en-US", { maximumFractionDigits: 0 }); }
export function shortDate(date) { return date ? String(date).slice(0, 10) : "—"; }
