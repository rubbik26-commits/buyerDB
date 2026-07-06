const BASE = import.meta.env.VITE_API_URL || "http://localhost:8000";

async function get(path, params) {
  const url = new URL(BASE + path);
  if (params) {
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
    });
  }
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${path} → HTTP ${r.status}`);
  return r.json();
}

async function post(path, body) {
  const r = await fetch(BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${path} → HTTP ${r.status}`);
  return r.json();
}

export const api = {
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
  async uploadFile(file, userId = "broker") {
    const fd = new FormData();
    fd.append("file", file);
    fd.append("user_id", userId);
    const r = await fetch(BASE + "/api/uploads", { method: "POST", body: fd });
    if (!r.ok) throw new Error(`upload → HTTP ${r.status}`);
    return r.json();
  },
};

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
