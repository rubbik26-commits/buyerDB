import type { Config, Context } from "@netlify/functions";

const env = (name: string) => (globalThis as any).Netlify?.env?.get?.(name) || "";
const present = (...names: string[]) => names.some(name => Boolean(env(name)));

export default async (_req: Request, _context: Context) => new Response(JSON.stringify({
  runtime: "netlify-supabase-blueprint",
  database: {
    url: present("SUPABASE_URL", "VITE_API_URL"),
    public_key: present("SUPABASE_ANON_KEY", "SUPABASE_PUBLISHABLE_KEY", "VITE_SUPABASE_ANON_KEY"),
    server_key: present("SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SERVICE_KEY"),
  },
  scraper: {
    scheduler_credential: present("SCRAPER_TRIGGER_SECRET", "SYNC_SECRET", "CRON_SECRET"),
    socrata: present("SOCRATA_APP_TOKEN"),
    scraperapi: present("SCRAPERAPI_KEY"),
    apify_token: present("APIFY_TOKEN"),
    apify_actor: present("APIFY_CREXI_ACTOR"),
  },
  ai: {
    groq: present("GROQ_API_KEY"),
    gemini: present("GEMINI_API_KEY"),
    openrouter: present("OPENROUTER_API_KEY"),
    cloudflare: present("CLOUDFLARE_ACCOUNT_ID") && present("CLOUDFLARE_API_TOKEN"),
    anthropic: present("ANTHROPIC_API_KEY"),
    openai: present("OPENAI_API_KEY"),
    fast_order: env("AI_PROVIDER_ORDER") || null,
    quality_order: env("AI_QUALITY_PROVIDER") || env("AI_QUALITY_PROVIDERS") || null,
  },
}), { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

export const config: Config = { path: "/api/runtime-health" };
