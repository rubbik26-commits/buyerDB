// _shared/mod.ts — the single implementation of the edge-function plumbing that
// was previously copy-pasted (with drift) across acris-v2, crexi-ingest,
// crexi-run, dos-enrich, skyline-sync, and traded-daily:
//   - config loading that FAILS CLOSED (a missing app_config row must never
//     authorize a request — `undefined !== undefined` is false),
//   - one canonicalizeAddress / normalizeEntity (four divergent copies used to
//     fork address_norm between sources and break cross-source dedupe),
//   - the sync_upsert_deals batching/totals accumulator.
// Edge functions are transport only: nothing in here decides facts.
import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";

export function serviceClient(): SupabaseClient {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Load app_config rows. Throws on query error. `required` keys must exist and
 * be non-empty — otherwise this throws instead of letting callers compare
 * secrets against `undefined` (the fail-open bug). */
export async function loadConfig(
  supa: SupabaseClient,
  keys: string[],
  required: string[] = keys,
): Promise<Record<string, string>> {
  const { data, error } = await supa.from("app_config").select("key,value").in("key", keys);
  if (error) throw new Error("app_config query failed: " + error.message);
  const conf = Object.fromEntries((data ?? []).map((r) => [r.key, r.value]));
  const missing = required.filter((k) => !conf[k]);
  if (missing.length) throw new Error("app_config missing required key(s): " + missing.join(", "));
  return conf;
}

/** Fail-closed secret check: an empty/absent expected value never authorizes. */
export function authorized(provided: unknown, expected: unknown): boolean {
  return typeof expected === "string" && expected.length > 0 && provided === expected;
}

// ---------------------------------------------------------------------------
// Normalization — ONE copy. Mirrors skyline/shared/normalize.py (the canonical
// Python implementation) as closely as the uppercase TS convention allows;
// output stays UPPERCASE because every sync-era row in the live DB was
// normalized that way and changing case would orphan them from dedupe.
// ---------------------------------------------------------------------------
export const PLACEHOLDER_OWNER =
  /^(unknown|n\/?a|not\s+specified|not\s+provided|not\s+disclosed|not\s+found|undisclosed|confidential|withheld|anonymous|private\s+investor|various|multiple|null|undefined|none|no\s+name|tbd|tba|-+|\*+)$/i;

export function isPlaceholderOwner(v: unknown): boolean {
  if (v == null || typeof v !== "string") return true;
  const t = v.trim();
  return !t || PLACEHOLDER_OWNER.test(t);
}

const SUFFIX: Record<string, string> = {
  STREET: "ST", ST: "ST", STR: "ST", AVENUE: "AVE", AVE: "AVE", AV: "AVE",
  BOULEVARD: "BLVD", BLVD: "BLVD", ROAD: "RD", RD: "RD", DRIVE: "DR", DR: "DR",
  LANE: "LN", LN: "LN", COURT: "CT", CT: "CT", PLACE: "PL", PL: "PL",
  PLAZA: "PLZ", TERRACE: "TER", TER: "TER", PARKWAY: "PKWY", PKWY: "PKWY",
  HIGHWAY: "HWY", EXPRESSWAY: "EXPY", SQUARE: "SQ", CIRCLE: "CIR", TURNPIKE: "TPKE",
};
const DIR: Record<string, string> = { EAST: "E", WEST: "W", NORTH: "N", SOUTH: "S" };
// Trailing location junk stripped iteratively: ZIP, then borough/state/county
// tokens, until stable. The old single-pass `$`-anchored replaces left
// "BROOKLYN NY" vs "BROOKLYN" depending on strip ORDER — the source of the
// cross-source address_norm fork.
const TRAILING_ZIP = /\s+\d{5}(-\d{4})?$/;
const TRAILING_PLACE = /\s+(NY|NYC|NEW YORK|MANHATTAN|BROOKLYN|QUEENS|BRONX|STATEN ISLAND|[A-Z][A-Z ]*COUNTY)$/;

export function canonicalizeAddress(raw: unknown): string {
  if (!raw || typeof raw !== "string") return "";
  let a = raw.trim().toUpperCase().replace(/[.,;:()#]/g, " ").replace(/\s+/g, " ").trim();
  for (;;) {
    const next = a.replace(TRAILING_ZIP, "").replace(TRAILING_PLACE, "").trim();
    if (next === a) break;
    a = next;
  }
  if (!a) return "";
  a = a.replace(/(\d+)(ST|ND|RD|TH)\b/g, "$1"); // ordinals, per shared/normalize.py
  return a.split(" ").map((t) => DIR[t] || SUFFIX[t] || t).join(" ").replace(/\s+/g, " ").trim();
}

export function normalizeEntity(name: unknown): string | null {
  if (!name || typeof name !== "string" || isPlaceholderOwner(name)) return null;
  const n = name.trim().toUpperCase()
    .replace(/L\.L\.C\.|LLC/gi, "LLC")
    .replace(/INC\.|INCORPORATED|INC/gi, "INC")
    .replace(/\s+/g, " ").trim();
  return n || null;
}

// ---------------------------------------------------------------------------
// sync_upsert_deals() transport
// ---------------------------------------------------------------------------
export type Totals = Record<string, number>;

export function newTotals(): Totals {
  return { inserted: 0, dup: 0, skipped_residential: 0, skipped_invalid: 0, parties: 0, contacts: 0, errors: 0 };
}

/** Push rows through sync_upsert_deals() in batches, accumulating totals and up
 * to 5 error samples. Returns false if any batch errored at the RPC level. */
export async function upsertDeals(
  supa: SupabaseClient,
  rows: unknown[],
  totals: Totals,
  errSamples: string[],
  batchSize = 500,
  shouldStop?: () => boolean,
): Promise<boolean> {
  let ok = true;
  for (let i = 0; i < rows.length; i += batchSize) {
    if (shouldStop?.()) break;
    const { data, error } = await supa.rpc("sync_upsert_deals", { rows: rows.slice(i, i + batchSize) });
    if (error) {
      ok = false;
      totals.errors += Math.min(batchSize, rows.length - i);
      if (errSamples.length < 5) errSamples.push("rpc: " + error.message);
    } else if (data) {
      for (const k of Object.keys(totals)) totals[k] += Number((data as Totals)[k] ?? 0);
      for (const s of ((data as { error_samples?: unknown[] }).error_samples ?? [])) {
        if (errSamples.length < 5) errSamples.push(String(s));
      }
    }
  }
  return ok;
}
