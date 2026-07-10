import React, { useEffect, useState, useCallback, useRef } from "react";
import { api, num } from "../api/client.js";
import { Loading, Empty, ErrorBanner } from "../components/ui.jsx";

export default function Review({ refreshMeta }) {
  const [filter, setFilter] = useState("");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const [acting, setActing] = useState(null);
  const seqRef = useRef(0);

  const load = useCallback(() => {
    const seq = ++seqRef.current;
    setLoading(true);
    setErr(null);
    return api.review({ status: "open", issue_class: filter, limit: 50 })
      .then((d) => {
        if (seq === seqRef.current) setData({ items: d.items || [], open_counts: d.open_counts || {} });
        return d;
      })
      .catch((e) => {
        if (seq === seqRef.current) setErr(e);
        throw e;
      })
      .finally(() => {
        if (seq === seqRef.current) setLoading(false);
      });
  }, [filter]);

  useEffect(() => { load().catch(() => {}); }, [load]);

  async function act(item, action, entity_id) {
    setActing(item.review_id);
    setErr(null);
    try {
      const result = await api.reviewAct({ review_id: item.review_id, action, entity_id, user_id: "broker" });
      if (result?.error) throw new Error(result.error);
      await load();
      refreshMeta && await refreshMeta();
    } catch (e) {
      setErr(e);
    } finally {
      setActing(null);
    }
  }

  const counts = data?.open_counts || {};
  const items = data?.items || [];

  return (
    <div className="content">
      <div className="view-head">
        <div className="eyebrow">Nothing merges without a human</div>
        <h1>Review queue</h1>
        <p>Ambiguous upload matches, property conflicts, and low-confidence parses stop here. A fuzzy owner is never linked until you select the entity, create a new one, or reject the row.</p>
      </div>

      <div className="filters">
        <div className="field">
          <label>Issue type</label>
          <div className="chip-row" style={{ flexWrap: "wrap" }}>
            <span className={`chip ${filter === "" ? "on" : ""}`} onClick={() => setFilter("")}>all</span>
            {Object.entries(counts).map(([k, v]) => (
              <span key={k} className={`chip ${filter === k ? "on" : ""}`} onClick={() => setFilter(k)}>{k} · {num(v)}</span>
            ))}
          </div>
        </div>
      </div>

      <ErrorBanner error={err} />
      {loading && !data ? <Loading label="Loading queue..." /> : null}
      {data && items.length === 0 ? <Empty title="Queue is clear." hint="No open items match this filter." /> : null}

      {data && items.map((it) => {
        const entityMerge = it.issue_class === "entity_merge" && it.payload;
        return (
          <div className="review-item" key={it.review_id}>
            <div className="h">
              <div>
                <span className="cls">{it.issue_class}</span>
                <span style={{ color: "var(--tx-mute)", fontFamily: "var(--mono)", fontSize: 11, marginLeft: 10 }}>{it.object_type}</span>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                {!entityMerge && <button className="btn ghost sm" disabled={acting === it.review_id} onClick={() => act(it, "resolve")}>Resolve</button>}
                <button className="btn ghost sm" disabled={acting === it.review_id} onClick={() => act(it, "dismiss")}>{entityMerge ? "Reject row" : "Dismiss"}</button>
              </div>
            </div>

            {entityMerge ? (
              <div style={{ marginTop: 10 }}>
                <div style={{ fontSize: 13 }}>
                  Uploaded entity <strong>{it.payload.name}</strong> resembles existing records. Select a verified match or create a new entity.
                </div>
                {(it.payload.property_address || it.payload.borough || it.payload.asset_type) && (
                  <div className="sc" style={{ marginTop: 6 }}>
                    {[it.payload.property_address, it.payload.borough, it.payload.asset_type].filter(Boolean).join(" · ")}
                  </div>
                )}
                {(it.payload.candidates || []).map((c) => (
                  <div className="cand" key={c.entity_id}>
                    <div>
                      <div className="nm">{c.display_name}</div>
                      <div className="sc">{c.reason} · score {c.score}</div>
                    </div>
                    <button className="btn brass sm" disabled={acting === it.review_id} onClick={() => act(it, "confirm_merge", c.entity_id)}>This is the match</button>
                  </div>
                ))}
                <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10 }}>
                  <button className="btn ghost sm" disabled={acting === it.review_id} onClick={() => act(it, "create_new")}>No match — create new entity</button>
                </div>
              </div>
            ) : (
              <div style={{ marginTop: 8, fontSize: 13, color: "var(--tx-dim)" }}>
                {it.payload?.address && <div><strong style={{ color: "var(--tx)" }}>{it.payload.address}</strong></div>}
                {it.payload?.notes && <div style={{ fontStyle: "italic", marginTop: 4 }}>{String(it.payload.notes).slice(0, 240)}</div>}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
