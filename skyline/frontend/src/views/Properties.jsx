import React, { useEffect, useState } from "react";
import { api, money, num, shortDate } from "../api/client.js";
import { Empty, EntityDrawer, ErrorBanner, Loading, Pill } from "../components/ui.jsx";

const EMPTY = { q: "", borough: "", asset_type: "", contact_gap: false };

export default function Properties({ meta }) {
  const [f, setF] = useState(EMPTY);
  const [applied, setApplied] = useState(EMPTY);
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(false);
  const [drawer, setDrawer] = useState(null);
  const [noteEntity, setNoteEntity] = useState(null);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  const load = () => {
    setLoading(true);
    setErr(null);
    api.properties({ ...applied, contact_gap: applied.contact_gap ? "true" : "", page, per_page: 40 })
      .then((d) => {
        if (d?.error) throw new Error(d.error);
        setData(d);
      })
      .catch(setErr)
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, [applied, page]);

  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value });
  const apply = () => { setApplied(f); setPage(1); };
  const reset = () => { setF(EMPTY); setApplied(EMPTY); setPage(1); };
  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.per_page)) : 1;

  async function saveInteraction() {
    if (!noteEntity || !note.trim()) return;
    setSaving(true);
    setErr(null);
    try {
      const result = await api.logInteraction({
        entity_id: noteEntity.owner_entity_id,
        channel: "other",
        subject: `Property note: ${noteEntity.address}`,
        notes: note,
        outcome: "logged from property owner workbench",
      });
      if (result?.error) throw new Error(result.error);
      setNote("");
      setNoteEntity(null);
      load();
    } catch (e) {
      setErr(e);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="content">
      <div className="view-head">
        <div className="eyebrow">Owner intelligence</div>
        <h1>Property owner workbench</h1>
        <p>
          Search every property tied to the transaction ledger, identify the latest known buyer/owner,
          spot contact gaps, open an entity dossier, and log broker notes without leaving the app.
        </p>
      </div>

      <div className="filters">
        <div className="field" style={{ minWidth: 260 }}>
          <label>Search address / BBL / owner</label>
          <input value={f.q} onChange={set("q")} placeholder="e.g. 101 Greenwich, Vanbarton, BBL" onKeyDown={(e) => e.key === "Enter" && apply()} />
        </div>
        <div className="field">
          <label>Borough</label>
          <select value={f.borough} onChange={set("borough")}>
            <option value="">All</option>
            {(meta.boroughs || []).map((b) => <option key={b}>{b}</option>)}
          </select>
        </div>
        <div className="field">
          <label>Asset type</label>
          <select value={f.asset_type} onChange={set("asset_type")}>
            <option value="">All</option>
            {(meta.asset_types || []).map((a) => <option key={a}>{a}</option>)}
          </select>
        </div>
        <div className="field">
          <label>Contact gap</label>
          <div className="chip-row">
            <span className={`chip ${f.contact_gap ? "on" : ""}`} onClick={() => setF({ ...f, contact_gap: !f.contact_gap })}>
              {f.contact_gap ? "missing only" : "any"}
            </span>
          </div>
        </div>
        <div className="spacer" />
        <button className="btn" onClick={apply}>Apply</button>
        <button className="btn ghost" onClick={reset}>Reset</button>
      </div>

      <ErrorBanner error={err} />
      {loading && !data ? <Loading label="Loading properties…" /> : null}

      {data && (
        <div style={{ opacity: loading ? 0.55 : 1, transition: "opacity 120ms" }}>
          <div style={{ display: "flex", gap: 22, marginBottom: 12, fontFamily: "var(--mono)", fontSize: 12.5, color: "var(--tx-dim)" }}>
            <span><strong style={{ color: "var(--tx)" }}>{num(data.total)}</strong> matching properties</span>
            <span>page <strong style={{ color: "var(--tx)" }}>{data.page}</strong> of {num(totalPages)}</span>
          </div>

          {data.total === 0 ? <Empty title="No properties match these filters." hint="Try a broader owner, borough, or asset query." /> : (
            <div className="tablewrap">
              <table className="deals">
                <thead>
                  <tr>
                    <th>Property</th>
                    <th>Latest owner / buyer</th>
                    <th>Asset</th>
                    <th className="num">Last price</th>
                    <th>Last sale</th>
                    <th>Workflow</th>
                  </tr>
                </thead>
                <tbody>
                  {data.properties.map((p) => (
                    <tr key={p.property_id} style={{ cursor: "default" }}>
                      <td>
                        <span className="addr">{p.address}</span>
                        <div style={{ color: "var(--tx-mute)", fontSize: 11 }}>{p.borough || "—"} · {p.market || "—"} · BBL {p.bbl || "—"}</div>
                      </td>
                      <td className="party">
                        {p.current_owner || "—"}
                        {p.seller && <div style={{ color: "var(--tx-mute)", fontSize: 11 }}>seller: {p.seller}</div>}
                      </td>
                      <td><Pill kind="asset">{p.asset_type || "—"}</Pill></td>
                      <td className="num">{money(p.sale_price, true)}</td>
                      <td className="money">{shortDate(p.sale_date)}</td>
                      <td>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                          <button className="btn ghost sm" disabled={!p.owner_entity_id} onClick={() => setDrawer(p.owner_entity_id)}>Dossier</button>
                          <button className="btn ghost sm" disabled={!p.owner_entity_id} onClick={() => { setNoteEntity(p); setNote(""); }}>Log note</button>
                          <Pill kind={p.has_contact ? "ok" : "review"}>{p.has_contact ? "contact" : "gap"}</Pill>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="pager">
            <div className="info">Page {data.page} of {num(totalPages)} · {num(data.total)} properties</div>
            <div className="btns">
              <button className="btn ghost sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>← Prev</button>
              <button className="btn ghost sm" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>Next →</button>
            </div>
          </div>
        </div>
      )}

      {noteEntity && (
        <div className="modalshade" onClick={() => setNoteEntity(null)}>
          <div className="modalcard" onClick={(e) => e.stopPropagation()}>
            <button className="btn ghost sm" style={{ float: "right" }} onClick={() => setNoteEntity(null)}>Close</button>
            <div className="view-head" style={{ marginBottom: 12 }}>
              <div className="eyebrow">Interaction log</div>
              <h1 style={{ fontSize: 24 }}>{noteEntity.current_owner}</h1>
              <p>{noteEntity.address}</p>
            </div>
            <textarea className="notearea" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Log call notes, email status, owner feedback, next step…" />
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
              <button className="btn ghost" onClick={() => setNoteEntity(null)}>Cancel</button>
              <button className="btn brass" disabled={!note.trim() || saving} onClick={saveInteraction}>{saving ? "Saving…" : "Save note"}</button>
            </div>
          </div>
        </div>
      )}

      <EntityDrawer entityId={drawer} onClose={() => setDrawer(null)} />
    </div>
  );
}
