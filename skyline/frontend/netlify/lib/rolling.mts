import { rpc, type Json } from "./supabase.mts";
import { agreed, BOROUGH_CODE, canonStreet, keyToken, quote, splitAddress } from "./normalize.mts";
import { socrata } from "./socrata.mts";

export async function runRolling(options: Json = {}) {
  const limit = Math.max(1, Math.min(1000, Number(options.limit || 400)));
  const targets = await rpc("sbi_rolling_targets", { lim: limit });
  const stats: Json = { targets: targets.length, sqft_filled: 0, units_filled: 0, conflict_flagged: 0, ambiguous: 0, nohit: 0, fetch_errors: 0 };
  for (const target of targets) {
    const [number, street] = splitAddress(target.address_raw);
    const token = keyToken(street);
    if (!number || !street || !token || !BOROUGH_CODE[target.borough]) {
      stats.nohit++;
      await rpc("sbi_rolling_apply", { p_deal_id: target.deal_id, p_sqft: null, p_units: null, p_source_rows: [] });
      continue;
    }
    try {
      const rows = await socrata("usep-8jbt", {
        "$select": "address,gross_square_feet,total_units,building_class_at_time_of,sale_price",
        "$where": `borough='${BOROUGH_CODE[target.borough]}' AND address like '${quote(number)} %${quote(token)}%'`,
        "$limit": "50",
      });
      const matches = rows.filter((row: Json) => canonStreet(String(row.address || "").replace(/^\S+\s+/, "")) === street && !String(row.building_class_at_time_of || "").toUpperCase().startsWith("R"));
      if (!matches.length) stats.nohit++;
      const sqft = agreed(matches.map((row: Json) => row.gross_square_feet));
      const units = agreed(matches.map((row: Json) => row.total_units));
      if (matches.length && sqft === null && units === null) stats.ambiguous++;
      const result = await rpc("sbi_rolling_apply", { p_deal_id: target.deal_id, p_sqft: sqft, p_units: units, p_source_rows: matches });
      for (const field of result.filled || []) {
        if (field === "sqft") stats.sqft_filled++;
        if (field === "units") stats.units_filled++;
      }
      stats.conflict_flagged += (result.conflicts || []).length;
    } catch (error) {
      stats.fetch_errors++;
      console.log("rolling", target.deal_id, String(error));
    }
  }
  return stats;
}
