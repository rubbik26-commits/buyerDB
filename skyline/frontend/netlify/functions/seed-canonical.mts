import type { Config } from "@netlify/functions";

type Row = Record<string, string>;
const RAW_CSV = "https://raw.githubusercontent.com/rubbik26-commits/buyerDB/ACRIS/skyline/NEW_YORK_CLOSED_ENRICHED_v8.csv";
const env = (name: string) => (globalThis as any).Netlify?.env?.get?.(name) || "";
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data, null, 2), { status, headers: { "content-type": "application/json" } });

function cfg() {
  const raw = env("SUPABASE_URL") || env("VITE_SUPABASE_URL") || env("VITE_API_URL");
  const key = env("SUPABASE_SERVICE_ROLE_KEY") || env("SUPABASE_SERVICE_KEY") || env("SUPABASE_PUBLISHABLE_KEY") || env("VITE_SUPABASE_ANON_KEY");
  if (!raw || !key) throw new Error("Supabase URL/key env vars are missing.");
  return { url: new URL(raw).origin, key };
}

async function rest(route: string, init: RequestInit = {}) {
  const c = cfg();
  const headers = new Headers(init.headers || {});
  headers.set("apikey", c.key);
  headers.set("authorization", `Bearer ${c.key}`);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const r = await fetch(`${c.url}/rest/v1/${route}`, { ...init, headers });
  const text = await r.text();
  if (!r.ok) throw new Error(`${route} ${r.status}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : null;
}

function parseCsv(text: string): Row[] {
  const rows: string[][] = [];
  let row: string[] = [], cur = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i], next = text[i + 1];
    if (q) {
      if (ch === '"' && next === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { row.push(cur); cur = ""; }
    else if (ch === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; }
    else if (ch !== "\r") cur += ch;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  const headers = (rows.shift() || []).map((h) => h.trim());
  return rows.filter((r) => r.length && r.some(Boolean)).map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] || ""])));
}

async function existingDeals() {
  const rows = await rest("sbi_deals?select=deal_id&limit=1");
  return Array.isArray(rows) && rows.length > 0;
}

export default async (req: Request) => {
  try {
    if (req.method !== "POST" && req.method !== "GET") return json({ error: "method_not_allowed" }, 405);
    const url = new URL(req.url);
    const force = url.searchParams.get("force") === "1";
    if (!force && await existingDeals()) return json({ status: "already_loaded", message: "sbi_deals already has rows; not re-seeding without force=1." });

    const res = await fetch(RAW_CSV, { headers: { "user-agent": "buyerdb-seed" } });
    if (!res.ok) throw new Error(`CSV fetch failed ${res.status}`);
    const text = await res.text();
    const rows = parseCsv(text);
    const batchSize = Math.max(50, Math.min(500, Number(url.searchParams.get("batch") || 250)));
    let totals: any = { properties: 0, deals: 0, entities: 0, parties: 0, reviews: 0 };
    for (let i = 0; i < rows.length; i += batchSize) {
      const out = await rest("rpc/api_seed_canonical_csv_rows", { method: "POST", body: JSON.stringify({ rows: rows.slice(i, i + batchSize) }) });
      for (const k of Object.keys(totals)) totals[k] += Number(out?.[k] || 0);
    }
    const counts = {
      deals: (await rest("sbi_deals?select=deal_id&limit=1")).length,
      sample: await rest("sbi_deals?select=deal_id,sale_date,asset_type,sale_price&order=sale_date.desc.nullslast&limit=5")
    };
    return json({ status: "seeded", csv_rows: rows.length, totals, counts });
  } catch (e: any) {
    return json({ error: e?.message || String(e) }, 500);
  }
};

export const config: Config = { path: "/api/admin/seed-canonical" };
