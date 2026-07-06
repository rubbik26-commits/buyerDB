// dos-enrich (Supabase-native rewrite — STAGED, deploy pending tool approval):
// NYS DOS active-corporations registry -> Skyline entities/contacts.
// Targets from dos_targets() RPC, writes via dos_apply() RPC (migration 008):
// mailing_address filled only when null; one 'nys_dos' contact per entity.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const DOS_DATASET = "https://data.ny.gov/resource/n9v6-gdp6.json";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36";
const DEADLINE_MS = 118_000;
const DOS_CHUNK = 40;

Deno.serve(async (req: Request) => {
  const start = Date.now(); const over = () => Date.now() - start > DEADLINE_MS;
  let body: any = {}; try { body = await req.json(); } catch { /* empty ok */ }
  const { data: cfg } = await supa.from("app_config").select("key,value").in("key", ["dealflow_secret"]);
  const conf = Object.fromEntries((cfg ?? []).map((r) => [r.key, r.value]));
  if (body.secret !== conf.dealflow_secret) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
  }
  try {
    const lim = Math.max(1, Math.min(2000, Number(body.limit) || 400));
    const { data: targets, error: tErr } = await supa.rpc("dos_targets", { lim });
    if (tErr) throw new Error("dos_targets: " + tErr.message);

    let queried = 0, matched = 0, noMatch = 0;
    const applies: any[] = [];
    for (let i = 0; i < (targets ?? []).length && !over(); i += DOS_CHUNK) {
      const chunk = targets.slice(i, i + DOS_CHUNK);
      const names = chunk.map((c: any) => String(c.norm_name).toUpperCase().trim().replace(/'/g, "''"));
      const where = encodeURIComponent(`upper(current_entity_name) in (${names.map((n: string) => `'${n}'`).join(",")})`);
      let rows: any[] = [];
      try {
        const res = await fetch(`${DOS_DATASET}?$where=${where}&$limit=2000`, { headers: { "User-Agent": UA } });
        if (res.ok) rows = await res.json();
      } catch { /* tolerate one bad chunk */ }
      queried += chunk.length;
      const byName = new Map<string, any>();
      for (const r of rows) { const k = String(r.current_entity_name || "").toUpperCase().trim(); if (k && !byName.has(k)) byName.set(k, r); }
      for (const c of chunk) {
        const r = byName.get(String(c.norm_name).toUpperCase().trim());
        if (!r) { noMatch++; continue; }
        matched++;
        const addr = [r.dos_process_address_1, r.dos_process_city, r.dos_process_state, r.dos_process_zip].filter(Boolean).join(", ");
        const agentDiffers = r.dos_process_name && String(r.dos_process_name).toUpperCase().trim() !== String(r.current_entity_name).toUpperCase().trim();
        applies.push({ entity_id: c.entity_id, mailing: addr || null, key_person: agentDiffers ? r.dos_process_name : null });
      }
    }
    let applied: any = { mailing_filled: 0, contacts_inserted: 0 };
    if (applies.length) {
      const { data, error } = await supa.rpc("dos_apply", { rows: applies });
      if (error) throw new Error("dos_apply: " + error.message);
      applied = data;
    }
    const summary = { ok: true, targets: (targets ?? []).length, queried, matched, no_match: noMatch, ...applied, elapsed_ms: Date.now() - start, hit_deadline: over() };
    console.log("dos-enrich:", JSON.stringify(summary));
    return new Response(JSON.stringify(summary), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
});
