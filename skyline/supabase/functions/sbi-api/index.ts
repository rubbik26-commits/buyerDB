import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

type Json = Record<string, unknown>;

const headers = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
};

function respond(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers });
}

function env(name: string) {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function adminClient() {
  return createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_KEY"), {
    auth: { persistSession: false }
  });
}

function textParam(url: URL, key: string) {
  const value = url.searchParams.get(key);
  return value && value.trim() ? value.trim() : null;
}

function intParam(url: URL, key: string, fallback: number, min: number, max: number) {
  const raw = url.searchParams.get(key);
  const value = raw === null ? fallback : Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function numericParam(url: URL, key: string) {
  const raw = url.searchParams.get(key);
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

async function route(req: Request) {
  if (req.method === "OPTIONS") return new Response(null, { headers });

  const url = new URL(req.url);
  const path = url.pathname.split("/sbi-api")[1] || "/";
  const db = adminClient();

  if (req.method === "GET" && (path === "/" || path === "/meta")) {
    const { data, error } = await db.rpc("sbi_api_meta");
    if (error) return respond({ success: false, error: error.message }, 500);
    return respond({ success: true, meta: data });
  }

  if (req.method === "GET" && path === "/deals") {
    const { data, error } = await db.rpc("sbi_search_deals", {
      p_query: textParam(url, "q"),
      p_borough: textParam(url, "borough"),
      p_asset_type: textParam(url, "asset_type"),
      p_min_price: numericParam(url, "min_price"),
      p_max_price: numericParam(url, "max_price"),
      p_since: textParam(url, "since"),
      p_limit: intParam(url, "limit", 100, 1, 500),
      p_offset: intParam(url, "offset", 0, 0, 100000)
    });
    if (error) return respond({ success: false, error: error.message }, 500);
    return respond({ success: true, deals: data ?? [] });
  }

  if (req.method === "GET" && path === "/buyers") {
    const { data, error } = await db.rpc("sbi_match_buyers", {
      p_asset_type: textParam(url, "asset_type"),
      p_borough: textParam(url, "borough"),
      p_price: numericParam(url, "price"),
      p_keywords: textParam(url, "keywords")?.split(",").map((s) => s.trim()).filter(Boolean) ?? [],
      p_since: textParam(url, "since"),
      p_limit: intParam(url, "limit", 25, 1, 100)
    });
    if (error) return respond({ success: false, error: error.message }, 500);
    return respond({ success: true, buyers: data ?? [] });
  }

  if (req.method === "GET" && path === "/entity") {
    const name = textParam(url, "name");
    if (!name) return respond({ success: false, error: "Missing name" }, 400);
    const { data, error } = await db.rpc("sbi_lookup_owner_or_buyer", { p_name: name });
    if (error) return respond({ success: false, error: error.message }, 500);
    return respond({ success: true, result: data });
  }

  if (req.method === "POST" && path === "/ingest/deal") {
    const body = (await req.json().catch(() => null)) as Json | null;
    if (!body) return respond({ success: false, error: "Invalid JSON" }, 400);

    const { data, error } = await db.rpc("sbi_ingest_deal", {
      p_address: body.address ?? null,
      p_borough: body.borough ?? null,
      p_neighborhood: body.neighborhood ?? null,
      p_market: body.market ?? null,
      p_asset_type: body.asset_type ?? null,
      p_transaction_type: body.transaction_type ?? "sale",
      p_sale_price: body.sale_price ?? null,
      p_units: body.units ?? null,
      p_sqft: body.sqft ?? body.square_feet ?? null,
      p_sale_date: body.sale_date ?? null,
      p_post_date: body.post_date ?? null,
      p_buyer: body.buyer ?? null,
      p_seller: body.seller ?? null,
      p_source_system: body.source_system ?? "manual",
      p_source_url: body.source_url ?? null,
      p_source_key: body.source_key ?? null,
      p_acris_doc_id: body.acris_doc_id ?? null,
      p_confidence: body.confidence ?? null,
      p_parse_status: body.parse_status ?? "ok",
      p_verification_status: body.verification_status ?? "unverified",
      p_record_quality: body.record_quality ?? "ok",
      p_notes: body.notes ?? null,
      p_provenance: body.provenance ?? {}
    });
    if (error) return respond({ success: false, error: error.message }, 500);
    return respond({ success: true, result: data });
  }

  return respond({ success: false, error: "Not found", path }, 404);
}

Deno.serve(async (req) => {
  try {
    return await route(req);
  } catch (error) {
    return respond({ success: false, error: error instanceof Error ? error.message : String(error) }, 500);
  }
});
