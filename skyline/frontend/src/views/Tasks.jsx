import React, { useEffect, useState } from "react";
import { api, money } from "../api/client.js";
import { Empty, EntityDrawer, ErrorBanner, Loading, Pill } from "../components/ui.jsx";

export default function Tasks() {
  const [tasks, setTasks] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);
  const [drawer, setDrawer] = useState(null);

  const load = () => {
    setLoading(true);
    setErr(null);
    api.tasks({ limit: 100 })
      .then((d) => {
        if (d?.error) throw new Error(d.error);
        setTasks(d.tasks || []);
      })
      .catch(setErr)
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  return (
    <div className="content">
      <div className="view-head">
        <div className="eyebrow">Broker workflow</div>
        <h1>Task worklist</h1>
        <p>
          Dealflow-style tasks generated from the actual database: missing contacts,
          open review items, and active buyers that need follow-up. No fake tasks,
          no mock rows, no swallowed gaps.
        </p>
      </div>

      <ErrorBanner error={err} />
      {loading && !tasks ? <Loading label="Loading worklist…" /> : null}
      {tasks && tasks.length === 0 ? <Empty title="No workflow tasks found." /> : null}

      {tasks && tasks.length > 0 && (
        <div className="tablewrap">
          <table className="deals">
            <thead>
              <tr>
                <th>Priority</th>
                <th>Task</th>
                <th>Type</th>
                <th className="num">Value</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((t, i) => (
                <tr key={`${t.kind}-${t.entity_id || t.review_id || i}`} style={{ cursor: "default" }}>
                  <td><Pill kind={t.priority === "high" ? "review" : "src"}>{t.priority || "normal"}</Pill></td>
                  <td>
                    <span className="addr">{t.title}</span>
                    <div style={{ color: "var(--tx-mute)", fontSize: 11 }}>{t.detail}</div>
                  </td>
                  <td><Pill kind="asset">{t.kind}</Pill></td>
                  <td className="num">{t.metric ? money(t.metric, true) : "—"}</td>
                  <td>
                    {t.entity_id ? (
                      <button className="btn ghost sm" onClick={() => setDrawer(t.entity_id)}>Open entity</button>
                    ) : (
                      <span style={{ color: "var(--tx-mute)", fontSize: 12 }}>Use Review tab</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ marginTop: 16 }}>
        <button className="btn ghost" onClick={load}>Refresh tasks</button>
      </div>

      <EntityDrawer entityId={drawer} onClose={() => setDrawer(null)} />
    </div>
  );
}
