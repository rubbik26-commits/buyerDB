import { runtimeRpc, type Json } from "./supabase.mts";
import { BOROUGH_CODE, canonStreet, dayDistance, keyToken, quote, splitAddress } from "./normalize.mts";
import { socrata } from "./socrata.mts";

async function fetchParties(documentId: string) {
  const rows = await socrata("636b-3b5g", { "$where": `document_id='${quote(documentId)}'`, "$order": "party_type ASC,name ASC", "$limit": "500" });
  const output: Json = {};
  for (const row of rows) {
    const address = [row.address_1, row.address_2, row.city, row.state, row.zip].filter(Boolean).join(", ") || null;
    if (row.party_type === "1" && !output.seller) { output.seller = row.name; output.seller_address = address; }
    if (row.party_type === "2" && !output.buyer) { output.buyer = row.name; output.buyer_address = address; }
  }
  return output;
}

export async function runPhase2(options: Json = {}) {
  const limit = Math.max(1, Math.min(1000, Number(options.limit || 400)));
  const targets = await runtimeRpc("sbi_runtime_phase2_targets", { p_lim: limit });
  const stats: Json = { targets: targets.length, legals_hit: 0, matched: 0, filled: 0, gated_out: 0, no_legals: 0, no_match: 0, fetch_errors: 0 };
  for (const target of targets) {
    const [number, street] = splitAddress(target.address_raw);
    const token = keyToken(street);
    if (!number || !street || !token || !BOROUGH_CODE[target.borough]) { stats.no_legals++; continue; }
    try {
      const legals = await socrata("8h5j-fqxa", {
        "$select": "document_id,street_number,street_name,borough,block,lot,property_type",
        "$where": `street_number='${quote(number)}' AND borough='${BOROUGH_CODE[target.borough]}' AND street_name like '%${quote(token)}%'`,
        "$limit": "5000",
      });
      const documentIds = [...new Set(legals.filter((row: Json) => canonStreet(row.street_name) === street).map((row: Json) => row.document_id).filter(Boolean))];
      if (!documentIds.length) { stats.no_legals++; continue; }
      stats.legals_hit++;
      const masters: Json[] = [];
      for (let index = 0; index < documentIds.length; index += 150) {
        const chunk = documentIds.slice(index, index + 150);
        masters.push(...await socrata("bnx9-e6tj", {
          "$select": "document_id,document_amt,document_date,doc_type",
          "$where": `document_id IN (${chunk.map(id => `'${quote(id)}'`).join(",")}) AND doc_type IN ('DEED','DEEDO','DEEDP')`,
          "$limit": "5000",
        }));
      }
      const deeds = masters.filter(row => Number(row.document_amt || 0) > 0);
      const price = Number(target.sale_price || 0);
      let match: Json | null = null;
      if (price > 0) {
        const candidates = deeds.filter(row => Math.abs(Number(row.document_amt) - price) / price <= 0.03).sort((a, b) => dayDistance(target.sale_date, a.document_date) - dayDistance(target.sale_date, b.document_date));
        if (candidates[0] && dayDistance(target.sale_date, candidates[0].document_date) <= 400) match = candidates[0];
      } else {
        const candidates = deeds.filter(row => Number(row.document_amt) >= 200000 && dayDistance(target.sale_date, row.document_date) <= 240).sort((a, b) => dayDistance(target.sale_date, a.document_date) - dayDistance(target.sale_date, b.document_date));
        if (candidates.length === 1 || (candidates.length > 1 && dayDistance(target.sale_date, candidates[0].document_date) < dayDistance(target.sale_date, candidates[1].document_date))) match = candidates[0];
      }
      if (!match) { stats.no_match++; continue; }
      stats.matched++;
      const parties = await fetchParties(match.document_id);
      const result = await runtimeRpc("sbi_runtime_phase2_apply", {
        p_deal_id: target.deal_id,
        p_doc_id: match.document_id,
        p_deed_amount: Number(match.document_amt),
        p_deed_date: String(match.document_date || "").slice(0, 10),
        p_buyer: parties.buyer || null,
        p_seller: parties.seller || null,
        p_buyer_address: parties.buyer_address || null,
        p_seller_address: parties.seller_address || null,
      });
      if (result.status === "filled") stats.filled++;
      else if (result.status === "gated_out") stats.gated_out++;
    } catch (error) {
      stats.fetch_errors++;
      console.log("phase2", target.deal_id, String(error));
    }
  }
  return stats;
}
