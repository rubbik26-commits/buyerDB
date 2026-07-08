import type { Config } from "@netlify/functions";

type Row = Record<string, any>;
const env = (name: string) => (globalThis as any).Netlify?.env?.get?.(name) || "";
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data, null, 2), { status, headers: { "content-type": "application/json" } });
const pathOf = (req: Request) => new URL(req.url).pathname.replace(/\/$/, "") || "/";
const qs = (req: Request) => new URL(req.url).searchParams;
const money = (v: unknown) => { if (v === null || v === undefined || v === "") return null; const n = Number(String(v).replace(/[$,\s]/g, "")); return Number.isFinite(n) ? n : null; };

const T = { deals: "sbi_deals", properties: "sbi_properties", parties: "sbi_deal_parties", entities: "sbi_entities", contacts: "sbi_contacts", review: "sbi_review_queue" };

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
  if (!r.ok) throw new Error(`${route} ${r.status}: ${(await r.text()).slice(0, 500)}`);
  return r.status === 204 ? null : r.json();
}
const sel = (table: string, query = "select=*") => rest(`${table}?${query}`);
const maybe = async (table: string, query = "select=*") => { try { return await sel(table, query); } catch { return []; } };
const patch = (route: string, body: unknown) => rest(route, { method: "PATCH", headers: { prefer: "return=representation" }, body: JSON.stringify(body) });

async function load() {
  const [deals, properties, parties, entities, contacts, reviews] = await Promise.all([
    sel(T.deals, "select=*&order=sale_date.desc.nullslast&limit=5000"),
    sel(T.properties, "select=*&limit=5000"),
    sel(T.parties, "select=*&limit=12000"),
    sel(T.entities, "select=*&limit=12000"),
    maybe(T.contacts, "select=*&limit=12000"),
    maybe(T.review, "select=*&status=eq.open&order=created_at.desc&limit=1000"),
  ]);
  const prop = new Map(properties.map((p: Row) => [p.property_id, p]));
  const ent = new Map(entities.map((e: Row) => [e.entity_id, e]));
  const byDeal = new Map<string, Row[]>();
  for (const p of parties) { if (!byDeal.has(p.deal_id)) byDeal.set(p.deal_id, []); byDeal.get(p.deal_id)!.push(p); }
  const contactsByEntity = new Map<string, Row[]>();
  for (const c of contacts) { if (!contactsByEntity.has(c.entity_id)) contactsByEntity.set(c.entity_id, []); contactsByEntity.get(c.entity_id)!.push(c); }
  const rows = deals.map((d: Row) => {
    const ps = byDeal.get(d.deal_id) || [];
    return { ...d, property: prop.get(d.property_id) || {}, parties: ps, buyers: ps.filter((p) => p.role === "buyer").map((p) => ent.get(p.entity_id)).filter(Boolean), sellers: ps.filter((p) => p.role === "seller").map((p) => ent.get(p.entity_id)).filter(Boolean) };
  });
  return { deals: rows, properties, parties, entities, contacts, reviews, ent, contactsByEntity };
}
function dealOut(d: Row) {
  const b = (d.buyers || [])[0], s = (d.sellers || [])[0];
  return { deal_id: d.deal_id, sale_date: d.sale_date, address: d.property?.address_raw, borough: d.property?.borough, market: d.property?.market, bbl: d.property?.bbl, asset_type: d.asset_type, buyer: b?.display_name, buyer_entity_id: b?.entity_id, seller: s?.display_name, seller_entity_id: s?.entity_id, sale_price: d.sale_price, units: d.units, sqft: d.sqft, ppu: d.ppu, ppsf: d.ppsf, confidence: d.confidence, parse_status: d.parse_status, source_url: d.source_url, source_system: d.source_system };
}
function filterDeals(rows: Row[], q: URLSearchParams) {
  const text = (q.get("q") || "").toLowerCase(), pmin = money(q.get("price_min")), pmax = money(q.get("price_max"));
  return rows.map(dealOut).filter((d) => (!text || `${d.address || ""} ${d.buyer || ""} ${d.seller || ""}`.toLowerCase().includes(text)) && (!q.get("borough") || d.borough === q.get("borough")) && (!q.get("asset_type") || d.asset_type === q.get("asset_type")) && (!q.get("market") || d.market === q.get("market")) && (pmin === null || Number(d.sale_price || 0) >= pmin) && (pmax === null || Number(d.sale_price || 0) <= pmax) && (!q.get("status") || d.parse_status === q.get("status")) && (q.get("has_buyer") !== "true" || !!d.buyer));
}
function buyers(data: Awaited<ReturnType<typeof load>>, f: Row = {}) {
  const m = new Map<string, Row>();
  for (const d of data.deals) {
    if (f.asset_type && d.asset_type !== f.asset_type) continue;
    if (f.borough && d.property?.borough !== f.borough) continue;
    for (const b of d.buyers || []) {
      const r = m.get(b.entity_id) || { entity_id: b.entity_id, name: b.display_name, is_spv_suspect: b.is_spv_suspect, n: 0, vol: 0, last_deal: null, types: new Set(), boroughs: new Set() };
      r.n += 1; r.vol += Number(d.sale_price || 0); r.last_deal = !r.last_deal || String(d.sale_date || "") > String(r.last_deal || "") ? d.sale_date : r.last_deal;
      if (d.asset_type) r.types.add(d.asset_type); if (d.property?.borough) r.boroughs.add(d.property.borough);
      m.set(b.entity_id, r);
    }
  }
  return Array.from(m.values()).map((r) => ({ ...r, deal_count: r.n, volume: r.vol, types: Array.from(r.types), boroughs: Array.from(r.boroughs), contact_count: (data.contactsByEntity.get(r.entity_id) || []).length, has_contact: (data.contactsByEntity.get(r.entity_id) || []).length > 0 }));
}
function leaderboards(data: Awaited<ReturnType<typeof load>>, groupBy = "asset_type", top = 5) {
  const groups = new Map<string, Row[]>();
  for (const d of data.deals) {
    const grp = groupBy === "borough" ? d.property?.borough : d.asset_type;
    if (!grp) continue;
    for (const b of d.buyers || []) { if (!groups.has(grp)) groups.set(grp, []); groups.get(grp)!.push({ entity_id: b.entity_id, name: b.display_name, sale_price: d.sale_price }); }
  }
  const out: Row[] = [];
  for (const [grp, arr] of groups) {
    const m = new Map<string, Row>();
    for (const r of arr) { const x = m.get(r.entity_id) || { grp, name: r.name, n: 0, vol: 0 }; x.n++; x.vol += Number(r.sale_price || 0); m.set(r.entity_id, x); }
    Array.from(m.values()).sort((a, b) => b.n - a.n || b.vol - a.vol).slice(0, top).forEach((r, i) => out.push({ ...r, rk: i + 1 }));
  }
  return out;
}

async function handle(req: Request) {
  const p = pathOf(req), q = qs(req), data = await load();
  if (p === "/api/health") return json({ status: "ok", runtime: "netlify-core-routes", schema: "sbi", deals: data.deals.length });
  if (p === "/api/meta") {
    const prices = data.deals.map((d: Row) => Number(d.sale_price || 0)).filter(Boolean), dates = data.deals.map((d: Row) => d.sale_date).filter(Boolean).sort();
    return json({ asset_types: Array.from(new Set(data.deals.map((d: Row) => d.asset_type).filter(Boolean))).sort(), boroughs: Array.from(new Set(data.properties.map((p: Row) => p.borough).filter(Boolean))).sort(), stats: { deals: data.deals.length, priced: prices.length, total_volume: prices.reduce((s, n) => s + n, 0), earliest: dates[0] || null, latest: dates.at(-1) || null, unique_buyers: buyers(data).length, contacts: data.contacts.length, open_reviews: data.reviews.length } });
  }
  if (p === "/api/deals") { const page = Math.max(1, Number(q.get("page") || 1)), per = Math.min(200, Math.max(1, Number(q.get("per_page") || 50))); const rows = filterDeals(data.deals, q); rows.sort((a, b) => String(b.sale_date || "").localeCompare(String(a.sale_date || ""))); return json({ total: rows.length, page, per_page: per, pulse: { n: rows.length, vol: rows.reduce((s, d) => s + Number(d.sale_price || 0), 0), median: null }, deals: rows.slice((page - 1) * per, page * per) }); }
  if (p === "/api/buyers") return json({ buyers: buyers(data, { borough: q.get("borough"), asset_type: q.get("asset_type") }).sort((a, b) => b.n - a.n || b.vol - a.vol).slice(0, Number(q.get("limit") || 60)) });
  if (p === "/api/leaderboards") return json({ boards: leaderboards(data, q.get("group_by") || "asset_type", Number(q.get("top") || 5)) });
  if (p.startsWith("/api/entities/")) { const id = decodeURIComponent(p.split("/").pop() || ""); const e = data.ent.get(id); if (!e) return json({ error: "not found" }, 404); return json({ entity: e, contacts: data.contactsByEntity.get(id) || [], deals: data.deals.filter((d: Row) => (d.parties || []).some((x: Row) => x.entity_id === id)).map(dealOut) }); }
  if (p === "/api/review/act" && req.method === "POST") { const b = await req.json(); const status = b.action === "resolve" || b.action === "confirm_merge" ? "resolved" : "dismissed"; await patch(`${T.review}?review_id=eq.${encodeURIComponent(b.review_id)}`, { status, resolved_by: b.user_id || "broker", resolved_at: new Date().toISOString() }); return json({ status }); }
  if (p === "/api/review") return json({ items: data.reviews, open_counts: data.reviews.reduce((o: Row, r: Row) => { o[r.issue_class] = (o[r.issue_class] || 0) + 1; return o; }, {}) });
  return json({ error: "not found", path: p }, 404);
}
export default async (req: Request) => { try { return await handle(req); } catch (e: any) { return json({ error: e?.message || String(e) }, 500); } };
export const config: Config = { path: ["/api/health", "/api/meta", "/api/deals", "/api/buyers", "/api/leaderboards", "/api/entities/*", "/api/review", "/api/review/act"] };
