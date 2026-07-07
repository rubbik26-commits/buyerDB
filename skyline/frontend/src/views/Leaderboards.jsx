import React, { useEffect, useState, useCallback, useRef } from "react";
import { api, money, num } from "../api/client.js";
import { Loading, Empty, ErrorBanner } from "../components/ui.jsx";

export default function Leaderboards() {
  const [groupBy, setGroupBy] = useState("asset_type");
  const [rankBy, setRankBy] = useState("count");
  const [top, setTop] = useState(3);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const seqRef = useRef(0);

  const load = useCallback(() => {
    const seq = ++seqRef.current; // stale responses must not overwrite newer ones
    setLoading(true); setErr(null);
    api.leaderboards({ group_by: groupBy, rank_by: rankBy, top })
      .then((d) => { if (seq === seqRef.current) setData(d); })
      .catch((e) => { if (seq === seqRef.current) setErr(e); })
      .finally(() => { if (seq === seqRef.current) setLoading(false); });
  }, [groupBy, rankBy, top]);
  useEffect(() => { load(); }, [load]);

  // group rows by their 'grp'
  const groups = {};
  (data?.boards || []).forEach((r) => { (groups[r.grp] ||= []).push(r); });

  return (
    <div className="content">
      <div className="view-head">
        <div className="eyebrow">Who owns each corner of the market</div>
        <h1>Leaderboards</h1>
        <p>The most active buyers in every segment, set as deal tombstones. Switch the cut between asset class and borough, and rank by count or capital deployed.</p>
      </div>

      <div className="filters">
        <div className="field">
          <label>Group by</label>
          <div className="chip-row">
            <span className={`chip ${groupBy === "asset_type" ? "on" : ""}`} onClick={() => setGroupBy("asset_type")}>asset type</span>
            <span className={`chip ${groupBy === "borough" ? "on" : ""}`} onClick={() => setGroupBy("borough")}>borough</span>
          </div>
        </div>
        <div className="field">
          <label>Rank by</label>
          <div className="chip-row">
            <span className={`chip ${rankBy === "count" ? "on" : ""}`} onClick={() => setRankBy("count")}>deal count</span>
            <span className={`chip ${rankBy === "vol" ? "on" : ""}`} onClick={() => setRankBy("vol")}>dollar volume</span>
          </div>
        </div>
        <div className="field">
          <label>Depth</label>
          <div className="chip-row">
            {[3, 5, 10].map((n) => <span key={n} className={`chip ${top === n ? "on" : ""}`} onClick={() => setTop(n)}>top {n}</span>)}
          </div>
        </div>
      </div>

      <ErrorBanner error={err} />
      {loading && !data ? <Loading label="Setting tombstones…" /> : null}

      {data && (Object.keys(groups).length === 0 ? (
        <Empty title="Nothing to rank yet." />
      ) : (
        Object.entries(groups).map(([grp, rows]) => (
          <div key={grp} style={{ marginBottom: 30, opacity: loading ? 0.55 : 1 }}>
            <h2 style={{ fontFamily: "var(--display)", fontSize: 19, fontWeight: 600, margin: "0 0 12px", color: "var(--tx)" }}>
              {grp} <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--tx-mute)" }}>· top {rows.length}</span>
            </h2>
            <div className="tombgrid">
              {rows.map((r) => (
                <div className="tomb" key={grp + r.name + r.rk}>
                  <div className="rank">№ {r.rk}</div>
                  <div className="grp">{grp}</div>
                  <div className="name">{r.name}</div>
                  <div className="rule" />
                  <div className="stats">
                    <div className="stat">
                      <div className="lab">Deals</div>
                      <div className="num">{rankBy === "count" ? <em>{num(r.n)}</em> : num(r.n)}</div>
                    </div>
                    <div className="stat" style={{ textAlign: "right" }}>
                      <div className="lab">Volume</div>
                      <div className="num">{rankBy === "vol" ? <em>{money(r.vol, true)}</em> : money(r.vol, true)}</div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))
      ))}
    </div>
  );
}
