import React, { useEffect, useState, useCallback, useRef } from "react";
import { api, money, num, shortDate } from "../api/client.js";
import { Pill, Loading, Empty, ErrorBanner, EntityDrawer } from "../components/ui.jsx";
import { downloadCsv } from "../lib/export.js";

export default function Buyers({ meta }) {
  const [borough, setBorough] = useState("");
  const [asset, setAsset] = useState("");
  const [rankBy, setRankBy] = useState("count");
  const [minDeals, setMinDeals] = useState(1);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const [drawer, setDrawer] = useState(null);
  const seqRef = useRef(0);

  const load = useCallback(() => {
    const seq = ++seqRef.current;
    setLoading(true);
    setErr(null);
    return api.buyers({ borough, asset_type: asset, rank_by: rankBy, min_deals: minDeals, limit: 60 })
      .then((d) => { if (seq === seqRef.current) setData({ buyers: d.buyers || [] }); return d; })
      .catch((e) => { if (seq === seqRef.current) setErr(e); throw e; })
      .finally(() => { if (seq === seqRef.current) setLoading(false); });
  }, [borough, asset, rankBy, minDeals]);
  useEffect(() => { load().catch(() => {}); }, [load]);
  const exportBuyers = () => downloadCsv("buyerdb-buyers.csv", data?.buyers || []);

  return (
    <div className="content">
      <div className="view-head"><div className="eyebrow">Capital in the market</div><h1>Buyers</h1><p>Every entity that has closed as a buyer, ranked by transaction count and dollar volume. Single-purpose entities are flagged so repeat capital stands out.</p></div>
      <div className="filters">
        <div className="field"><label>Borough</label><select value={borough} onChange={(e) => setBorough(e.target.value)}><option value="">All</option>{(meta.boroughs || []).map((b) => <option key={b}>{b}</option>)}</select></div>
        <div className="field"><label>Asset type</label><select value={asset} onChange={(e) => setAsset(e.target.value)}><option value="">All</option>{(meta.asset_types || []).map((a) => <option key={a}>{a}</option>)}</select></div>
        <div className="field"><label>Rank by</label><div className="chip-row"><span className={`chip ${rankBy === "count" ? "on" : ""}`} onClick={() => setRankBy("count")}>deal count</span><span className={`chip ${rankBy === "vol" ? "on" : ""}`} onClick={() => setRankBy("vol")}>dollar volume</span></div></div>
        <div className="field"><label>Minimum deals</label><div className="chip-row">{[1, 2, 3, 5].map((n) => <span key={n} className={`chip ${minDeals === n ? "on" : ""}`} onClick={() => setMinDeals(n)}>{n}+</span>)}</div></div>
        <div className="spacer" />
        <button className="btn ghost" disabled={!data?.buyers?.length} onClick={exportBuyers}>Export CSV</button>
      </div>
      <ErrorBanner error={err} />
      {loading && !data ? <Loading label="Ranking buyers..." /> : null}
      {data && (data.buyers.length === 0 ? <Empty title="No buyers match." hint="Lower the minimum-deals threshold." /> : <div className="buyergrid">{data.buyers.map((b) => <div className="buyer" key={b.entity_id} onClick={() => setDrawer(b.entity_id)}><div className="top"><div className="nm">{b.name}</div>{b.is_spv_suspect ? <Pill kind="spv">SPV</Pill> : b.has_contact ? <Pill kind="ok">contact</Pill> : null}</div><div className="metrics"><div className="metric"><div className="lab">Deals</div><div className="val">{num(b.n || b.deal_count)}</div></div><div className="metric"><div className="lab">Volume</div><div className="val">{money(b.vol || b.volume, true)}</div></div><div className="metric"><div className="lab">Last</div><div className="val" style={{ fontSize: 13 }}>{shortDate(b.last_deal)}</div></div></div><div className="tags">{(b.types || b.asset_types || []).slice(0, 3).map((t) => <Pill key={t} kind="asset">{t}</Pill>)}{(b.boroughs || []).slice(0, 3).map((t) => <Pill key={t} kind="src">{t}</Pill>)}</div></div>)}</div>)}
      <EntityDrawer entityId={drawer} onClose={() => setDrawer(null)} />
    </div>
  );
}
