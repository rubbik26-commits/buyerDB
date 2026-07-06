import React, { useEffect, useState, useCallback } from "react";
import { api, num } from "../api/client.js";
import { Pill, Loading, Empty, ErrorBanner } from "../components/ui.jsx";

export default function Review({ refreshMeta }) {
  const [filter, setFilter] = useState("");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const [acting, setActing] = useState(null);

  const load = useCallback(() => {
    setLoading(true); setErr(null);
    api.review({ status: "open", issue_class: filter, limit: 50 })
      .then(setData).catch(setErr).finally(() => setLoading(false));
  }, [filter]);
  useEffect(() => { load(); }, [load]);

  async function act(item, action, entity_id) {
    setActing(item.review_id);
    try {
      await api.reviewAct({ review_id: item.review_id, action, entity_id, user_id: "broker" });
      await load();
      refreshMeta && refreshMeta();
    } catch (e) { setErr(e); }
    finally { setActing(null); }
  }

  const counts = data?.open_counts || {};

  return (
    <div className="content">
      <div className="view-head">
        <div className="eyebrow">Nothing merges without a human</div>
        <h1>Review queue</h1>
        <p>Flags the pipeline raised and won’t resolve on its own: fuzzy owner matches from your uploads, square-foot and geography conflicts, and legacy low-confidence parses. Confirm, reject, or dismiss each.</p>
      </div>

      <div className="filters">
        <div className="field">
          <label>Issue type</label>
          <div className="chip-row" style={{ flexWrap: "wrap" }}>
            <span className={`chip ${filter === "" ? "on" : ""}`} onClick={() => setFilter("")}>all</span>
            {Object.entries(counts).map(([k, v]) => (
              <span key={k} className={`chip ${filter === k ? "on" : ""}`} onClick={() => setFilter(k)}>{k} · {v}</span>
            ))}
          </div>
        </div>
      </div>

      <ErrorBanner error={err} />
      {loading && !data ? <Loading label="Loading queue…" /> : null}

      {data && (data.items.length === 0 ? (
        <Empty title="Queue is clear." hint="No open items match this filter." />
      ) : (
        data.items.map((it) => (
          <div className="review-item" key={it.review_id}>
            <div className="h">
              <div>
                <span className="cls">{it.issue_class}</span>
                <span style={{ color: "var(--tx-mute)", fontFamily: "var(--mono)", fontSize: 11, marginLeft: 10 }}>{it.object_type}</span>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button className="btn ghost sm" disabled={acting === it.review_id} onClick={() => act(it, "resolve")}>Resolve</button>
                <button className="btn ghost sm" disabled={acting === it.review_id} onClick={() => act(it, "dismiss")}>Dismiss</button>
              </div>
            </div>

            {it.issue_class === "entity_merge" && it.payload ? (
              <div style={{ marginTop: 10 }}>
                <div style={{ fontSize: 13 }}>
                  Uploaded owner <strong>{it.payload.name}</strong> resembles existing entities — confirm the match to link the contact:
                </div>
                {(it.payload.candidates || []).map((c) => (
                  <div className="cand" key={c.entity_id}>
                    <div>
                      <div className="nm">{c.display_name}</div>
                      <div className="sc">{c.reason} · score {c.score}</div>
                    </div>
                    <button className="btn brass sm" disabled={acting === it.review_id} onClick={() => act(it, "confirm_merge", c.entity_id)}>This is the match</button>
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ marginTop: 8, fontSize: 13, color: "var(--tx-dim)" }}>
                {it.payload?.address && <div><strong style={{ color: "var(--tx)" }}>{it.payload.address}</strong></div>}
                {it.payload?.notes && <div style={{ fontStyle: "italic", marginTop: 4 }}>{String(it.payload.notes).slice(0, 240)}</div>}
              </div>
            )}
          </div>
        ))
      ))}
    </div>
  );
}
