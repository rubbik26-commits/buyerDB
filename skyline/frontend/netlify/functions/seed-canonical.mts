import type { Config } from "@netlify/functions";

type Row = Record<string, string>;
const RAW_CSV = "https://raw.githubusercontent.com/rubbik26-commits/buyerDB/ACRIS/skyline/NEW_YORK_CLOSED_ENRICHED_v8.csv";
const env = (name: string) => (globalThis as any).Netlify?.env?.get?.(name) || "";
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data, null, 2), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

function cfg() {
  const raw = env("SUPABASE_URL") || env("VITE_API_URL");
  const key = env("SUPABASE_SERVICE_ROLE_KEY") || env("SUPABASE_SERVICE_KEY");
  const adminSecret = env("SEED_ADMIN_SECRET") || env("SCRAPER_TRIGGER_SECRET") || env("SYNC_SECRET");
  if (!raw || !key) throw new Error("Canonical seeding requires the live Supabase URL and a service-role key.");
  if (!adminSecret) throw new Error("Canonical seeding requires a server-side admin credential.");
  return { url: new URL(raw).origin, key, adminSecret };
}

async function rest(route: string, init: RequestInit = {}) {
  const c = cfg();
  const headers = new Headers(init.headers || {});
  headers.set("apikey", c.key);
  headers.set("authorization", `Bearer ${c.key}`);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(`${c.url}/rest/v1/${route}`, { ...init, headers });
  const text = await response.text();
  if (!response.ok) throw new Error(`${route} ${response.status}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : null;
}

function parseCsv(text: string): Row[] {
  const rows: string[][] = [];
  let row: string[] = [], cur = "", quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index], next = text[index + 1];
    if (quoted) {
      if (char === '"' && next === '"') { cur += '"'; index++; }
      else if (char === '"') quoted = false;
      else cur += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") { row.push(cur); cur = ""; }
    else if (char === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; }
    else if (char !== "\r") cur += char;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  const headers = (rows.shift() || []).map((header) => header.trim());
  return rows
    .filter((values) => values.length && values.some(Boolean))
    .map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] || ""])));
}

function factless(row: Row) {
  return ["Shortcode", "Source URL", "sale_date_iso", "Sale Date", "Sale Price", "Buyer", "Seller", "Asset Type"]
    .every((field) => !String(row[field] || "").trim());
}

export default async (req: Request) => {
  try {
    if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    const config = cfg();
    if (req.headers.get("x-seed-admin-secret") !== config.adminSecret) return json({ error: "forbidden" }, 403);

    const url = new URL(req.url);
    const force = url.searchParams.get("force") === "1";
    const existing = await rest("sbi_deals?select=deal_id&limit=1");
    if (!force && Array.isArray(existing) && existing.length > 0) {
      return json({ status: "already_loaded", message: "sbi_deals already has rows; not re-seeding without force=1." });
    }

    const response = await fetch(RAW_CSV, { headers: { "user-agent": "buyerdb-seed" } });
    if (!response.ok) throw new Error(`CSV fetch failed ${response.status}`);
    const parsed = parseCsv(await response.text());
    const rows = parsed.filter((row) => !factless(row));
    const skippedFactless = parsed.length - rows.length;
    const batchSize = Math.max(50, Math.min(500, Number(url.searchParams.get("batch") || 250)));
    const totals: Record<string, number> = { properties: 0, deals: 0, entities: 0, parties: 0, reviews: 0, skipped_factless: skippedFactless };
    for (let index = 0; index < rows.length; index += batchSize) {
      const result = await rest("rpc/api_seed_canonical_csv_rows", { method: "POST", body: JSON.stringify({ rows: rows.slice(index, index + batchSize) }) });
      for (const key of Object.keys(totals)) totals[key] += Number(result?.[key] || 0);
    }
    const counts = {
      deals: (await rest("sbi_deals?select=deal_id&limit=1")).length,
      sample: await rest("sbi_deals?select=deal_id,sale_date,asset_type,sale_price&order=sale_date.desc.nullslast&limit=5"),
    };
    return json({ status: "seeded", csv_rows: parsed.length, accepted_rows: rows.length, totals, counts });
  } catch (error: any) {
    return json({ error: error?.message || String(error) }, 500);
  }
};

export const config: Config = { path: "/api/admin/seed-canonical" };
