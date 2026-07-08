import type { Config, Context } from "@netlify/functions";

type Message = { role: "system" | "user" | "assistant"; content: string };
type ProviderResult = { text: string; provider: string; model: string };

const SYSTEM = `You are Skyline Buyer Intelligence OS, a NYC commercial real estate deal-intelligence assistant.

Rules:
- Be concise and broker-useful.
- Do not invent phone numbers, emails, owners, buyers, prices, or deal facts.
- If the question asks for contact info and none is provided in the prompt/context, say the system needs the contacts table/backend to answer.
- If the question asks for buyer recommendations without database rows, say a backend database query is required.
- Explain limitations plainly.`;

export default async (req: Request, context: Context) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  let body: any = {};
  try { body = await req.json(); } catch { return json({ error: "invalid_json" }, 400); }
  const question = String(body.question || "").trim();
  const history = Array.isArray(body.history) ? body.history.slice(-6) : [];
  if (!question) return json({ error: "missing_question" }, 400);

  const messages: Message[] = [
    { role: "system", content: SYSTEM },
    ...history.filter((m: any) => m && (m.role === "user" || m.role === "assistant") && m.content).map((m: any) => ({ role: m.role, content: String(m.content) })),
    { role: "user", content: question },
  ];

  const errors: string[] = [];
  for (const provider of providerOrder()) {
    try {
      const result = await complete(provider, messages);
      return json({ answer: result.text, providers: { synthesis: result.provider }, tool: "netlify_ai_direct", arguments: {}, result: { note: "Netlify Function AI fallback. Database-backed tools require the FastAPI backend or Supabase RPC tool layer." } });
    } catch (err: any) {
      errors.push(`${provider}: ${err?.message || String(err)}`.slice(0, 240));
    }
  }

  return json({ error: "no_ai_provider_available", detail: errors.join("; ") || "No provider keys configured for Netlify Functions.", hint: "Set at least one AI provider key in Netlify environment variables." }, 503);
};

export const config: Config = { path: "/api/agent", method: ["POST"] };

function providerOrder(): string[] { const order = Netlify.env.get("AI_PROVIDER_ORDER") || "groq,gemini,openrouter,cloudflare,anthropic,openai"; return order.split(",").map((s) => s.trim()).filter(Boolean); }
async function complete(provider: string, messages: Message[]): Promise<ProviderResult> { switch (provider) { case "groq": return openAICompatible("groq", "https://api.groq.com/openai/v1", Netlify.env.get("GROQ_API_KEY"), Netlify.env.get("GROQ_MODEL") || "llama-3.3-70b-versatile", messages); case "gemini": return openAICompatible("gemini", "https://generativelanguage.googleapis.com/v1beta/openai", Netlify.env.get("GEMINI_API_KEY"), Netlify.env.get("GEMINI_MODEL") || "gemini-2.5-flash", messages); case "openrouter": return openAICompatible("openrouter", "https://openrouter.ai/api/v1", Netlify.env.get("OPENROUTER_API_KEY"), Netlify.env.get("OPENROUTER_MODEL") || "meta-llama/llama-3.3-70b-instruct:free", messages); case "cloudflare": { const account = Netlify.env.get("CLOUDFLARE_ACCOUNT_ID"); const token = Netlify.env.get("CLOUDFLARE_API_TOKEN"); if (!account) throw new Error("missing CLOUDFLARE_ACCOUNT_ID"); return openAICompatible("cloudflare", `https://api.cloudflare.com/client/v4/accounts/${account}/ai/v1`, token, Netlify.env.get("CLOUDFLARE_MODEL") || "@cf/meta/llama-3.1-8b-instruct", messages); } case "anthropic": return anthropic(messages); case "openai": return openAICompatible("openai", "https://api.openai.com/v1", Netlify.env.get("OPENAI_API_KEY"), Netlify.env.get("OPENAI_MODEL") || "gpt-4o-mini", messages); default: throw new Error("unknown provider"); } }
async function openAICompatible(provider: string, baseUrl: string, apiKey: string | undefined, model: string, messages: Message[]): Promise<ProviderResult> { if (!apiKey) throw new Error("not configured"); const res = await fetch(`${baseUrl}/chat/completions`, { method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify({ model, messages, max_tokens: 900 }) }); const text = await res.text(); if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 180)}`); const data = JSON.parse(text); return { provider, model, text: data.choices?.[0]?.message?.content || "" }; }
async function anthropic(messages: Message[]): Promise<ProviderResult> { const apiKey = Netlify.env.get("ANTHROPIC_API_KEY"); const model = Netlify.env.get("ANTHROPIC_MODEL") || "claude-sonnet-4-6"; if (!apiKey) throw new Error("not configured"); const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n"); const convo = messages.filter((m) => m.role !== "system"); const res = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "Content-Type": "application/json" }, body: JSON.stringify({ model, max_tokens: 900, system, messages: convo }) }); const text = await res.text(); if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 180)}`); const data = JSON.parse(text); return { provider: "anthropic", model, text: (data.content || []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("") }; }
function json(payload: any, status = 200) { return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }); }
