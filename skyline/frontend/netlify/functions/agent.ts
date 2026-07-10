import type { Config, Context } from "@netlify/functions";
import { effectiveSupabasePublishableKey, effectiveSupabaseUrl, netlifyEnv } from "../lib/public-config.mts";

type Message = { role: "system" | "user" | "assistant"; content: string };
type Plan = { tool: string; arguments: Record<string, unknown>; why: string };
type ProviderResult = { provider: string; model: string; text: string; latency_ms: number; input_tokens?: number; output_tokens?: number };

const BUILD = "blueprint-sql-agent-2026-07-10";
const env = netlifyEnv;
const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });

const TOOL_CATALOG = `
lookup_contact(q, lim): phone/email/mailing rows from the contacts database.
last_interaction(q, lim): latest logged calls, emails, texts, meetings or notes.
find_similar_buyers(asset_type, borough, price, keywords, lim): best-fit buyers scored from real track record; SPVs discounted.
buyer_leaderboard(borough, asset_type, price_min, price_max, date_min, min_deals, rank_by, lim): top buyers by count or volume.
entity_history(q, party_role, lim): complete buyer/seller deal history.
similar_sellers(asset_type, borough, lim): sellers who transacted comparable assets.
missing_contacts(asset_type, borough, min_deals, lim): active entities with no phone/email on file.
recent_changes(days, lim): rows recently inserted or updated.
recent_deals(q, lim): recent matching transaction rows.
`;

const PLANNER = `You plan one database tool call for a NYC commercial real-estate brokerage system.
Return only JSON: {"tool":"name","arguments":{},"why":"short reason"}.
Neighborhood mapping: Williamsburg/Bushwick/DUMBO/Park Slope/Bed-Stuy -> Brooklyn; Astoria/LIC/Flushing/Jamaica -> Queens; Harlem/SoHo/Tribeca/Chelsea/Midtown -> Manhattan; Mott Haven/Fordham/Riverdale -> Bronx.
Asset types: Multifamily, Office, Retail, Industrial, Hotel, Mixed-Use, Development Site, Garage/Auto, Commercial, Storage.
Tools:${TOOL_CATALOG}`;

const SYNTHESIS = `You are Skyline Buyer Intelligence OS. Answer only from the database tool result supplied.
Never invent a buyer, owner, deal, phone, email, price or interaction. If a contact value is missing, say it is not on file and that public records generally provide mailing addresses, not phones/emails.
For buyer recommendations explain the real track record, deal count, volume, score and recent activity. Discount address-named single-purpose LLCs when the result flags them.
Cite verifiable row identifiers such as entity_id, deal_id or shortcode when present. Be direct and useful to a NYC investment-sales broker.`;

export default async (req: Request, _context: Context) => {
  if (req.method === "GET") {
    return json({ build: BUILD, database: Boolean(supabaseUrl() && publicKey()), providers: providerPresence() });
  }
  if (req.method !== "POST") return json({ error: "method_not_allowed", build: BUILD }, 405);
  let body: any = {};
  try { body = await req.json(); } catch { return json({ error: "invalid_json", build: BUILD }, 400); }
  const question = String(body.question || "").trim();
  const history = Array.isArray(body.history) ? body.history.slice(-6) : [];
  const userId = String(body.user_id || "broker");
  if (!question) return json({ error: "missing_question", build: BUILD }, 400);

  let plan = deterministicPlan(question);
  let planProvider = "deterministic";
  const plannerErrors: string[] = [];
  if (!plan) {
    const messages: Message[] = [{ role: "system", content: PLANNER }, ...cleanHistory(history), { role: "user", content: question }];
    try {
      const out = await completeChain(messages, "fast", "plan", userId, false, true);
      plan = parsePlan(out.text);
      planProvider = out.provider;
    } catch (error: any) {
      plannerErrors.push(error?.message || String(error));
      plan = { tool: "recent_deals", arguments: { q: question, lim: 10 }, why: "Fallback to a literal deal search because no planner provider returned usable JSON." };
    }
  }

  try {
    const result = await runTool(plan.tool, plan.arguments);
    const sensitive = ["lookup_contact", "last_interaction", "entity_history"].includes(plan.tool);
    let answer = deterministicAnswer(plan, result);
    let synthesisProvider = "deterministic";
    const providerErrors: string[] = [];
    const messages: Message[] = [
      { role: "system", content: SYNTHESIS },
      ...cleanHistory(history),
      { role: "user", content: `Question: ${question}\nTool: ${plan.tool}\nArguments: ${JSON.stringify(plan.arguments)}\nDatabase result: ${JSON.stringify(result).slice(0, 12000)}\nAnswer from these rows only.` },
    ];
    try {
      const out = await completeChain(messages, "quality", "synthesize", userId, sensitive, false);
      if (out.text.trim()) answer = out.text.trim();
      synthesisProvider = out.provider;
    } catch (error: any) {
      providerErrors.push(error?.message || String(error));
    }
    return json({ build: BUILD, tool: plan.tool, arguments: plan.arguments, plan_why: plan.why, result, answer, providers: { plan: planProvider, synthesis: synthesisProvider }, planner_errors: plannerErrors, provider_errors: providerErrors });
  } catch (error: any) {
    return json({ build: BUILD, error: "agent_database_query_failed", detail: error?.message || String(error), tool: plan.tool, arguments: plan.arguments }, 500);
  }
};

export const config: Config = { path: "/api/agent" };

function supabaseUrl() { return effectiveSupabaseUrl(); }
function publicKey() { return effectiveSupabasePublishableKey(); }
function serviceKey() { return env("SUPABASE_SERVICE_ROLE_KEY") || env("SUPABASE_SERVICE_KEY"); }

async function rpc(fn: string, args: Record<string, unknown>, write = false) {
  const base = supabaseUrl();
  const key = write ? (serviceKey() || publicKey()) : (publicKey() || serviceKey());
  if (!base || !key) throw new Error("Supabase URL/key is not configured for the Netlify function runtime.");
  const res = await fetch(`${base}/rest/v1/rpc/${fn}`, { method: "POST", headers: { "Content-Type": "application/json", apikey: key, Authorization: `Bearer ${key}` }, body: JSON.stringify(args || {}) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${fn} returned HTTP ${res.status}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : {};
}

async function runTool(tool: string, args: Record<string, unknown>) {
  switch (tool) {
    case "lookup_contact": return rpc("api_contact_search", { q: args.q || args.entity_name, lim: Number(args.lim || 10) });
    case "last_interaction": return rpc("api_last_interaction", { q: args.q || args.entity_name, lim: Number(args.lim || 5) });
    case "find_similar_buyers": return rpc("api_similar_buyers", { asset_type: args.asset_type || null, borough: args.borough || null, price: numeric(args.price), keywords: Array.isArray(args.keywords) ? args.keywords : [], lim: Number(args.lim || 15) });
    case "buyer_leaderboard": return rpc("api_buyers", { borough: args.borough || null, asset_type: args.asset_type || null, price_min: numeric(args.price_min), price_max: numeric(args.price_max), date_min: args.date_min || args.since || null, min_deals: Number(args.min_deals || 1), rank_by: args.rank_by || "vol", lim: Number(args.lim || 25) });
    case "entity_history": return rpc("api_entity_history", { q: args.q || args.entity_name, party_role: args.party_role || args.role || null, lim: Number(args.lim || 100) });
    case "similar_sellers": return rpc("api_similar_sellers", { asset_type: args.asset_type || null, borough: args.borough || null, lim: Number(args.lim || 25) });
    case "missing_contacts": return rpc("api_missing_contacts", { asset_type: args.asset_type || null, borough: args.borough || null, min_deals: Number(args.min_deals || 2), lim: Number(args.lim || 50) });
    case "recent_changes": return rpc("api_recent_changes", { days: Number(args.days || 7), lim: Number(args.lim || 50) });
    case "recent_deals": return rpc("api_recent_deals", { q: args.q || "", lim: Number(args.lim || 10) });
    default: throw new Error(`Unknown or disallowed agent tool: ${tool}`);
  }
}

function deterministicPlan(question: string): Plan | null {
  const q = question.toLowerCase();
  const asset = assetFrom(question), borough = boroughFrom(question), price = priceFrom(question);
  if (/\b(best|ideal|likely|recommended|top)\b.*\bbuyer|\bbuyer\b.*\bfor\b/.test(q)) return { tool: "find_similar_buyers", arguments: { asset_type: asset, borough, price, keywords: keywordsFrom(question), lim: 15 }, why: "Rank buyers against the property profile using the blueprint scoring model." };
  if (/\b(top|active|most active)\b.*\bbuyers?\b|\bbuyer leaderboard\b/.test(q)) return { tool: "buyer_leaderboard", arguments: { asset_type: asset, borough, price_min: price ? price * 0.5 : null, price_max: price ? price * 1.5 : null, min_deals: 1, rank_by: "vol", lim: 25 }, why: "Aggregate real buyer activity in the requested segment." };
  if (/\b(phone|email|contact|cell|telephone)\b/.test(q)) return { tool: "lookup_contact", arguments: { q: entityQuery(question), lim: 10 }, why: "Look up contact fields from database rows only." };
  if (/\b(last|when)\b.*\b(contact|talk|call|email|spoke|interaction)\b/.test(q)) return { tool: "last_interaction", arguments: { q: entityQuery(question), lim: 5 }, why: "Retrieve the latest logged interaction." };
  if (/\b(history|deals did|bought|sold|transactions for)\b/.test(q)) return { tool: "entity_history", arguments: { q: entityQuery(question), party_role: /sold|seller/.test(q) ? "seller" : /bought|buyer/.test(q) ? "buyer" : null, lim: 100 }, why: "Retrieve the entity's sourced transaction history." };
  if (/\b(sellers?|owners?)\b.*\b(similar|comparable|target|prospect)\b/.test(q)) return { tool: "similar_sellers", arguments: { asset_type: asset, borough, lim: 25 }, why: "Identify sellers with comparable transaction history." };
  if (/\b(missing|no)\b.*\b(contact|phone|email)\b|\bcontact gaps?\b/.test(q)) return { tool: "missing_contacts", arguments: { asset_type: asset, borough, min_deals: 2, lim: 50 }, why: "Return active entities without a phone/email row." };
  if (/\b(recent changes?|newly added|updated)\b/.test(q)) return { tool: "recent_changes", arguments: { days: daysFrom(question) || 7, lim: 50 }, why: "Find recent database inserts and updates." };
  if (/\b(recent|latest|show|find)\b.*\b(deals?|transactions?|sales?)\b/.test(q)) return { tool: "recent_deals", arguments: { q: searchQuery(question), lim: 10 }, why: "Search recent transaction rows." };
  return null;
}

function parsePlan(text: string): Plan {
  const clean = text.replace(/```json|```/gi, "").trim();
  const start = clean.indexOf("{"), end = clean.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("Planner did not return a JSON object.");
  const parsed = JSON.parse(clean.slice(start, end + 1));
  if (!parsed.tool || typeof parsed.arguments !== "object") throw new Error("Planner JSON is missing tool/arguments.");
  const allowed = new Set(["lookup_contact", "last_interaction", "find_similar_buyers", "buyer_leaderboard", "entity_history", "similar_sellers", "missing_contacts", "recent_changes", "recent_deals"]);
  if (!allowed.has(parsed.tool)) throw new Error(`Planner selected disallowed tool ${parsed.tool}.`);
  return { tool: parsed.tool, arguments: parsed.arguments || {}, why: String(parsed.why || "AI planner selection") };
}

function deterministicAnswer(plan: Plan, result: any) {
  if (plan.tool === "find_similar_buyers") {
    const rows = result?.candidates || [];
    return rows.length ? rows.slice(0, 10).map((r: any, i: number) => `${i + 1}. ${r.name} — score ${Number(r.score || 0).toFixed(1)}, ${Number(r.deal_count || 0).toLocaleString()} deals, ${money(r.volume)}, entity ${r.entity_id}${r.has_contact ? ", contact on file" : ", no contact on file"}`).join("\n") : "No buyer candidates matched those criteria.";
  }
  if (plan.tool === "buyer_leaderboard") {
    const rows = result?.buyers || [];
    return rows.length ? rows.slice(0, 10).map((r: any, i: number) => `${i + 1}. ${r.name} — ${r.n} deals, ${money(r.vol)}, entity ${r.entity_id}`).join("\n") : "No matching buyer rows were returned.";
  }
  if (plan.tool === "lookup_contact") {
    const lines = (result?.matches || []).flatMap((m: any) => (m.contacts || []).map((c: any) => `${m.name} (${m.entity_id}): ${c.phone || "no phone"}; ${c.email || "no email"}; source ${c.source || "unknown"}`));
    return lines.length ? lines.join("\n") : "No phone or email is on file for that entity. Public records generally provide mailing addresses, not phone/email data.";
  }
  if (plan.tool === "last_interaction") {
    const rows = result?.matches || [];
    return rows.length ? rows.map((m: any) => (m.interactions || []).length ? `${m.name}: ${(m.interactions || []).map((x: any) => `${String(x.occurred_at).slice(0, 10)} ${x.channel || "interaction"} — ${x.subject || x.notes || "no note"}`).join("; ")}` : `${m.name}: no logged interactions`).join("\n") : "No matching entity or interaction was found.";
  }
  if (plan.tool === "entity_history") return (result?.deals || []).length ? (result.deals || []).slice(0, 15).map((d: any) => `${d.sale_date || "date unknown"} — ${d.role} — ${d.address} — ${money(d.sale_price)} — ${d.shortcode || d.deal_id}`).join("\n") : "No deal history was returned.";
  if (plan.tool === "similar_sellers") return (result?.sellers || []).length ? result.sellers.slice(0, 15).map((r: any, i: number) => `${i + 1}. ${r.name} — ${r.sales} sales, ${money(r.volume)}, entity ${r.entity_id}`).join("\n") : "No matching seller rows were returned.";
  if (plan.tool === "missing_contacts") return (result?.entities_missing_contact || []).length ? result.entities_missing_contact.slice(0, 15).map((r: any, i: number) => `${i + 1}. ${r.name} — ${r.deals} deals, ${money(r.volume)}, entity ${r.entity_id}`).join("\n") : "No matching contact gaps were returned.";
  const rows = result?.deals || [];
  return rows.length ? rows.slice(0, 15).map((d: any, i: number) => `${i + 1}. ${d.address || "Unknown address"} — ${d.asset_type || "asset"} — ${money(d.sale_price)} — ${d.shortcode || d.deal_id || "row"}`).join("\n") : "No matching deal rows were returned.";
}

function providerPresence() {
  return { groq: Boolean(env("GROQ_API_KEY")), gemini: Boolean(env("GEMINI_API_KEY")), openrouter: Boolean(env("OPENROUTER_API_KEY")), cloudflare: Boolean(env("CLOUDFLARE_ACCOUNT_ID") && env("CLOUDFLARE_API_TOKEN")), anthropic: Boolean(env("ANTHROPIC_API_KEY")), openai: Boolean(env("OPENAI_API_KEY")) };
}
function providerOrder(lane: "fast" | "quality") {
  const fast = (env("AI_PROVIDER_ORDER") || "groq,gemini,openrouter,cloudflare,anthropic,openai").split(",").map(x => x.trim()).filter(Boolean);
  if (lane === "fast") return fast;
  const quality = (env("AI_QUALITY_PROVIDER") || env("AI_QUALITY_PROVIDERS") || "anthropic,openai,groq,openrouter").split(",").map(x => x.trim()).filter(Boolean);
  return [...new Set([...quality, ...fast])];
}
async function completeChain(messages: Message[], lane: "fast" | "quality", purpose: string, userId: string, sensitive: boolean, jsonMode: boolean) {
  const failures: string[] = [];
  let fallbackFrom = "";
  for (const provider of providerOrder(lane)) {
    if (sensitive && provider === "gemini") continue;
    try {
      const result = await callProvider(provider, messages, jsonMode);
      await logAi(userId, result, purpose, fallbackFrom || null, "ok");
      return result;
    } catch (error: any) {
      const detail = `${provider}: ${error?.message || String(error)}`;
      failures.push(detail.slice(0, 300));
      await logAi(userId, { provider, model: "", text: "", latency_ms: 0 }, purpose, fallbackFrom || null, `error:${detail.slice(0, 120)}`);
      fallbackFrom = provider;
    }
  }
  throw new Error(failures.length ? failures.join(" | ") : "No configured AI provider was available.");
}

async function callProvider(provider: string, messages: Message[], jsonMode: boolean): Promise<ProviderResult> {
  const started = Date.now();
  if (provider === "anthropic") {
    const key = env("ANTHROPIC_API_KEY"); if (!key) throw new Error("not configured");
    const model = env("ANTHROPIC_MODEL") || "claude-sonnet-4-6";
    const system = messages.filter(m => m.role === "system").map(m => m.content).join("\n");
    const convo = messages.filter(m => m.role !== "system");
    const res = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "Content-Type": "application/json" }, body: JSON.stringify({ model, max_tokens: 1200, system, messages: convo }) });
    const raw = await res.text(); if (!res.ok) throw new Error(`HTTP ${res.status} ${raw.slice(0, 200)}`);
    const data = JSON.parse(raw); return { provider, model, text: (data.content || []).filter((c: any) => c.type === "text").map((c: any) => c.text).join(""), latency_ms: Date.now() - started, input_tokens: data.usage?.input_tokens, output_tokens: data.usage?.output_tokens };
  }
  let base = "", key = "", model = "";
  if (provider === "groq") { base = "https://api.groq.com/openai/v1"; key = env("GROQ_API_KEY"); model = env("GROQ_MODEL") || "llama-3.3-70b-versatile"; }
  else if (provider === "gemini") { base = "https://generativelanguage.googleapis.com/v1beta/openai"; key = env("GEMINI_API_KEY"); model = env("GEMINI_MODEL") || "gemini-2.5-flash"; }
  else if (provider === "openrouter") { base = "https://openrouter.ai/api/v1"; key = env("OPENROUTER_API_KEY"); model = env("OPENROUTER_MODEL") || "meta-llama/llama-3.3-70b-instruct:free"; }
  else if (provider === "cloudflare") { const account = env("CLOUDFLARE_ACCOUNT_ID"); key = env("CLOUDFLARE_API_TOKEN"); if (!account) throw new Error("account not configured"); base = `https://api.cloudflare.com/client/v4/accounts/${account}/ai/v1`; model = env("CLOUDFLARE_MODEL") || "@cf/meta/llama-3.1-8b-instruct"; }
  else if (provider === "openai") { base = "https://api.openai.com/v1"; key = env("OPENAI_API_KEY"); model = env("OPENAI_MODEL") || "gpt-4o-mini"; }
  else throw new Error("unknown provider");
  if (!key) throw new Error("not configured");
  const payload: any = { model, messages, max_tokens: 1200 };
  if (jsonMode) payload.response_format = { type: "json_object" };
  const res = await fetch(`${base}/chat/completions`, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  const raw = await res.text(); if (!res.ok) throw new Error(`HTTP ${res.status} ${raw.slice(0, 200)}`);
  const data = JSON.parse(raw); return { provider, model, text: data.choices?.[0]?.message?.content || "", latency_ms: Date.now() - started, input_tokens: data.usage?.prompt_tokens, output_tokens: data.usage?.completion_tokens };
}

async function logAi(userId: string, result: ProviderResult, purpose: string, fallbackFrom: string | null, status: string) {
  if (!serviceKey()) return;
  try { await rpc("sbi_log_ai", { p_user_id: userId, p_provider: result.provider, p_model: result.model || null, p_purpose: purpose, p_latency_ms: result.latency_ms || null, p_input_tokens: result.input_tokens || null, p_output_tokens: result.output_tokens || null, p_fallback_from: fallbackFrom, p_status: status }, true); } catch { /* logging cannot break the answer */ }
}

function cleanHistory(history: any[]): Message[] { return history.filter(m => m && (m.role === "user" || m.role === "assistant" || m.role === "agent") && String(m.content || "").trim()).map(m => ({ role: m.role === "user" ? "user" : "assistant", content: String(m.content) })); }
function numeric(value: unknown) { if (value === null || value === undefined || value === "") return null; const n = Number(String(value).replace(/[$,\s]/g, "")); return Number.isFinite(n) ? n : null; }
function assetFrom(text: string) { const q = text.toLowerCase(); if (/multi[- ]?family|apartment/.test(q)) return "Multifamily"; if (q.includes("office")) return "Office"; if (q.includes("retail")) return "Retail"; if (q.includes("industrial")) return "Industrial"; if (q.includes("hotel") || q.includes("hospitality")) return "Hotel"; if (q.includes("mixed")) return "Mixed-Use"; if (/development|vacant|land/.test(q)) return "Development Site"; if (/garage|parking/.test(q)) return "Garage/Auto"; if (q.includes("storage")) return "Storage"; return null; }
function boroughFrom(text: string) { const q = text.toLowerCase(); if (/brooklyn|williamsburg|bushwick|dumbo|park slope|bed-stuy|bedford-stuyvesant|sunset park/.test(q)) return "Brooklyn"; if (/queens|astoria|long island city|\blic\b|flushing|jamaica|sunnyside/.test(q)) return "Queens"; if (/bronx|mott haven|fordham|riverdale/.test(q)) return "Bronx"; if (/staten island/.test(q)) return "Staten Island"; if (/manhattan|harlem|soho|tribeca|chelsea|midtown|upper east side|upper west side|inwood|hudson yards/.test(q)) return "Manhattan"; return null; }
function priceFrom(text: string) { const m = text.match(/\$?([0-9]+(?:\.[0-9]+)?)\s*(billion|bn|b|million|mm|m|thousand|k)?\b/i); if (!m) return null; const n = Number(m[1]), u = String(m[2] || "").toLowerCase(); if (["billion", "bn", "b"].includes(u)) return n * 1e9; if (["million", "mm", "m"].includes(u)) return n * 1e6; if (["thousand", "k"].includes(u)) return n * 1e3; return n >= 100000 ? n : null; }
function daysFrom(text: string) { const m = text.match(/(?:last|past)\s+(\d+)\s+days?/i); return m ? Number(m[1]) : null; }
function keywordsFrom(text: string) { return [...new Set(text.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/\s+/).filter(x => x.length > 3 && !["buyer", "best", "around", "property", "building", "million", "brooklyn", "manhattan", "queens", "bronx", "multifamily", "office", "retail", "industrial"].includes(x)))].slice(0, 6); }
function entityQuery(text: string) { return text.replace(/what'?s|what is|who is|phone number|phone|email|contact|cell|telephone|when did we last|last interaction|deal history|transaction history|bought|sold|buyer|seller|owner|for/gi, " ").replace(/[^a-z0-9 &.'-]+/gi, " ").replace(/\s+/g, " ").trim(); }
function searchQuery(text: string) { return text.replace(/recent|latest|show|find|deals?|transactions?|sales?|for|about/gi, " ").replace(/\s+/g, " ").trim(); }
function money(value: unknown) { const n = Number(value || 0); if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`; if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`; return `$${Math.round(n).toLocaleString()}`; }
