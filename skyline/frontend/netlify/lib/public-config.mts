const DEFAULT_SUPABASE_URL = "https://pdvyuepsdnpxctmagdcq.supabase.co";
const DEFAULT_SUPABASE_PUBLISHABLE_KEY = "sb_publishable_UjrNaspF-2DWK9RFYmX1Zw_1Ju8nT2w";

export function netlifyEnv(name: string) {
  return (globalThis as any).Netlify?.env?.get?.(name) || "";
}

export function effectiveSupabaseUrl() {
  return (netlifyEnv("SUPABASE_URL") || netlifyEnv("VITE_API_URL") || DEFAULT_SUPABASE_URL).replace(/\/$/, "");
}

export function effectiveSupabasePublishableKey() {
  return netlifyEnv("SUPABASE_PUBLISHABLE_KEY")
    || netlifyEnv("SUPABASE_ANON_KEY")
    || netlifyEnv("VITE_SUPABASE_ANON_KEY")
    || DEFAULT_SUPABASE_PUBLISHABLE_KEY;
}

export function publicSupabaseConfigSource() {
  return {
    url: netlifyEnv("SUPABASE_URL") || netlifyEnv("VITE_API_URL") ? "environment" : "public_fallback",
    key: netlifyEnv("SUPABASE_PUBLISHABLE_KEY") || netlifyEnv("SUPABASE_ANON_KEY") || netlifyEnv("VITE_SUPABASE_ANON_KEY")
      ? "environment"
      : "public_fallback",
  };
}
