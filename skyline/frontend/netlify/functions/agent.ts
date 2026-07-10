import type { Config, Context } from "@netlify/functions";

const env = (name: string) => (globalThis as any).Netlify?.env?.get?.(name) || "";

export default async (req: Request, _context: Context) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  let body: any = {};
  try { body = await req.json(); } catch { return json({ error: "invalid_json" }, 400); }

  const question = String(body.question || "").trim();
  if (!question) return json({ error: "missing_question" }, 400);

  try {
    const q = question.toLowerCase();

    if (q.includes("buyer")) {
      const args = {
        borough: boroughFrom(question),
        asset_type: assetFrom(question),
        price_min: priceFrom(question) ? Math.round(priceFrom(question)! * 0.5) : null,
        price_max: priceFrom(question) ? Math.round(priceFrom(question)! * 1.5) : null,
        min_deals: 1,
        lim: 10,
      };
      const result = await rpc("api_buyers", args);
      const buyers = Array.isArray(result?.buyers) ? result.buyers : [];
      const answer = buyers.length
        ? buyers.slice(0, 10).map((b: any, i: number) => `${i + 1}. ${b.name} — ${Number(b.n || 0).toLocaleString()} deals, ${money(b.vol)} total volume${b.has_contact ? ", contact on file" : ", no contact on file"}`).join("\n")
        : "No matching buyers were returned by the live database for those criteria.";
      return json({ tool: "api_buyers", arguments: args, result: { candidates: buyers }, answer, providers: { plan: "deterministic", synthesis: "deterministic" } });
    }

    if (q.includes("phone") || q.includes("email") || q.includes("contact")) {
      const term = question.replace(/what'?s|what is|phone number|email|contact|for|owner|buyer|seller|who is/gi, " ").replace(/\s+/g, " ").trim();
      const result = await rpc("api_contact_search", { q: term, lim: 10 });
      const matches = Array.isArray(result?.matches) ? result.matches : [];
      const lines = matches.flatMap((m: any) => (m.contacts || []).map((c: any) => `${m.name}: ${c.phone || "no phone"} / ${c.email || "no email"}`));
      return json({ tool: "api_contact_search", arguments: { q: term, lim: 10 }, result, answer: lines.length ? lines.join("\n") : `No phone or email is on file for ${term || "that entity"}.`, providers: { plan: "deterministic", synthesis: "deterministic" } });
    }

    const result = await rpc("api_recent_deals", { q: question, lim: 10 });
    const deals = Array.isArray(result?.deals) ? result.deals : [];
    const answer = deals.length
      ? deals.map((d: any, i: number) => `${i + 1}. ${d.address || "Unknown address"} — ${d.asset_type || "asset"} — ${money(d.sale_price)} — buyer: ${d.buyer || "unknown"}`).join("\n")
      : "No matching deal rows were returned by the live database.";
    return json({ tool: "api_recent_deals", arguments: { q: question, lim: 10 }, result, answer, providers: { plan: "deterministic", synthesis: "deterministic" } });
  } catch (err: any) {
    return json({ error: "agent_database_query_failed", detail: err?.message || String(err) }, 500);
  }
};

export const config: Config = { path: "/api/agent" };

async function rpc(fn: string, args: Record<string, unknown>) {
  const base = env("SUPABASE_URL") || env("VITE_API_URL") || "https://pdvyuepsdnpxctmagdcq.supabase.co";
  const key = env("SUPABASE_ANON_KEY") || env("VITE_SUPABASE_ANON_KEY");
  if (!key) throw new Error("SUPABASE_ANON_KEY or VITE_SUPABASE_ANON_KEY is not configured for Netlify Functions");
  const res = await fetch(`${base.replace(/\/$/, "")}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: key, Authorization: `Bearer ${key}` },
    body: JSON.stringify(args),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${fn} returned HTTP ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

function boroughFrom(text: string) {
  const q = text.toLowerCase();
  if (q.includes("brooklyn")) return "Brooklyn";
  if (q.includes("manhattan")) return "Manhattan";
  if (q.includes("queens")) return "Queens";
  if (q.includes("bronx")) return "Bronx";
  if (q.includes("staten island")) return "Staten Island";
  return null;
}

function assetFrom(text: string) {
  const q = text.toLowerCase();
  if (q.includes("multifamily") || q.includes("apartment")) return "Multifamily";
  if (q.includes("office")) return "Office";
  if (q.includes("retail")) return "Retail";
  if (q.includes("industrial")) return "Industrial";
  if (q.includes("hotel")) return "Hotel";
  if (q.includes("development") || q.includes("vacant") || q.includes("land")) return "Development Site";
  if (q.includes("mixed")) return "Mixed-Use";
  return null;
}

function priceFrom(text: string) {
  const m = text.match(/\$?([0-9]+(?:\.[0-9]+)?)\s*(m|million|k|thousand)?/i);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = String(m[2] || "").toLowerCase();
  if (unit === "m" || unit === "million") return n * 1_000_000;
  if (unit === "k" || unit === "thousand") return n * 1_000;
  return n;
}

function money(value: any) {
  const n = Number(value || 0);
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  return `$${Math.round(n).toLocaleString()}`;
}

function json(payload: any, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}
