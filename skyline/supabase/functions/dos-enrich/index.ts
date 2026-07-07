// dos-enrich (Supabase-native rewrite — STAGED, deploy pending tool approval):
// NYS DOS active-corporations registry -> Skyline entities/contacts.
// Targets from dos_targets() RPC, writes via dos_apply() RPC (migration 008):
// mailing_address filled only when null; one 'nys_dos' contact per entity.
// v2: shared plumbing, fail-closed auth, DOS fetch failures counted separately
// from genuine no-matches, registered-agent mills never stored as key persons.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { authorized, json, loadConfig, serviceClient } from "../_shared/mod.ts";

const supa = serviceClient();
const DOS_DATASET = "https://data.ny.gov/resource/n9v6-gdp6.json";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36";
const DEADLINE_MS = 118_000;
const DOS_CHUNK = 40;

// Service-of-process addressees that are registration mills / statutory agents,
// not people connected to the entity. Storing one as a key person would be a
// fabricated contact association (invariant 5).
const REGISTERED_AGENT_MILLS =
  /\b(C\s*T\s+CORPORATION|CORPORATION\s+SERVICE\s+COMPANY|REGISTERED\s+AGENT|NATIONAL\s+REGISTERED\s+AGENTS|NORTHWEST\s+REGISTERED|INCORP\s+SERVICES|COGENCY\s+GLOBAL|VCORP|URS\s+AGENTS|LEGALINC|HARVARD\s+BUSINESS\s+SERVICES|SPIEGEL\s*&\s*UTRERA|UNITED\s+STATES\s+CORPORATION\s+AGENTS|LEGALZOOM)\b/i;

Deno.serve(async (req: Request) => {
  const start = Date.now(); const over = () => Date.now() - start > DEADLINE_MS;
  let body: any = {}; try { body = await req.json(); } catch { /* empty ok */ }
  let conf: Record<string, string>;
  try {
    conf = await loadConfig(supa, ["dealflow_secret"]);
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
  if (!authorized(body.secret, conf.dealflow_secret)) return json({ error: "unauthorized" }, 401);
  try {
    const lim = Math.max(1, Math.min(2000, Number(body.limit) || 400));
    const { data: targets, error: tErr } = await supa.rpc("dos_targets", { lim });
    if (tErr) throw new Error("dos_targets: " + tErr.message);

    let queried = 0, matched = 0, noMatch = 0, fetchFailed = 0, agentsFiltered = 0;
    const errSamples: string[] = [];
    const applies: any[] = [];
    for (let i = 0; i < (targets ?? []).length && !over(); i += DOS_CHUNK) {
      const chunk = targets.slice(i, i + DOS_CHUNK);
      const names = chunk.map((c: any) => String(c.norm_name).toUpperCase().trim().replace(/'/g, "''"));
      const where = encodeURIComponent(`upper(current_entity_name) in (${names.map((n: string) => `'${n}'`).join(",")})`);
      let rows: any[] = [];
      let chunkFailed = false;
      try {
        const res = await fetch(`${DOS_DATASET}?$where=${where}&$limit=2000`, { headers: { "User-Agent": UA } });
        if (res.ok) rows = await res.json();
        else { chunkFailed = true; if (errSamples.length < 5) errSamples.push(`dos fetch ${res.status}`); }
      } catch (e) { chunkFailed = true; if (errSamples.length < 5) errSamples.push("dos fetch: " + String(e)); }
      // A failed DOS call must not count its whole chunk as "these entities
      // don't exist in DOS" — a sustained outage would look like no-matches.
      if (chunkFailed) { fetchFailed += chunk.length; continue; }
      queried += chunk.length;
      const byName = new Map<string, any>();
      for (const r of rows) { const k = String(r.current_entity_name || "").toUpperCase().trim(); if (k && !byName.has(k)) byName.set(k, r); }
      for (const c of chunk) {
        const r = byName.get(String(c.norm_name).toUpperCase().trim());
        if (!r) { noMatch++; continue; }
        matched++;
        const addr = [r.dos_process_address_1, r.dos_process_city, r.dos_process_state, r.dos_process_zip].filter(Boolean).join(", ");
        const agentName = r.dos_process_name ? String(r.dos_process_name).trim() : null;
        const agentDiffers = agentName && agentName.toUpperCase() !== String(r.current_entity_name).toUpperCase().trim();
        const isMill = agentName && REGISTERED_AGENT_MILLS.test(agentName);
        if (agentDiffers && isMill) agentsFiltered++;
        applies.push({ entity_id: c.entity_id, mailing: addr || null, key_person: agentDiffers && !isMill ? agentName : null });
      }
    }
    let applied: any = { mailing_filled: 0, contacts_inserted: 0 };
    if (applies.length) {
      const { data, error } = await supa.rpc("dos_apply", { rows: applies });
      if (error) throw new Error("dos_apply: " + error.message);
      applied = data;
    }
    const summary = { ok: true, targets: (targets ?? []).length, queried, matched, no_match: noMatch, fetch_failed: fetchFailed, registered_agents_filtered: agentsFiltered, ...applied, error_samples: errSamples, elapsed_ms: Date.now() - start, hit_deadline: over() };
    console.log("dos-enrich:", JSON.stringify(summary));
    return json(summary);
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
});
