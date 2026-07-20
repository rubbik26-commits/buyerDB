import React, { useCallback, useEffect, useState } from "react";
import { api, num, shortDate, IS_RPC_MODE } from "../api/client.js";
import { Empty, Loading, ErrorBanner, Pill } from "../components/ui.jsx";

const FIELDS = [
  "", "entity_name", "person_name", "role", "title", "phone", "email", "website",
  "mailing_address", "property_address", "borough", "asset_type", "last_contact_date",
  "interaction_notes", "channel",
];

export default function Uploads({ refreshMeta }) {
  const [stage, setStage] = useState("drop");
  const [over, setOver] = useState(false);
  const [staged, setStaged] = useState(null);
  const [mapping, setMapping] = useState({});
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [history, setHistory] = useState(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyErr, setHistoryErr] = useState(null);

  const hasEntityMapping = Object.values(mapping || {}).includes("entity_name");

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    setHistoryErr(null);
    try {
      const response = await api.uploads();
      if (response?.error) throw new Error(response.error);
      setHistory(response?.uploads || []);
    } catch (error) {
      setHistoryErr(error);
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  useEffect(() => { loadHistory(); }, [loadHistory]);

  async function handleFile(file) {
    if (!file) return;
    if (IS_RPC_MODE && !/\.csv$/i.test(file.name)) {
      setErr(new Error(`Supabase RPC mode supports CSV contact imports. Excel imports require the optional FastAPI backend: ${file.name}`));
      return;
    }
    if (!/\.(csv|xlsx?|xls)$/i.test(file.name)) {
      setErr(new Error(`Unsupported file type: ${file.name}. Use CSV${IS_RPC_MODE ? "" : " or Excel"}.`));
      return;
    }
    setBusy(true); setErr(null);
    try {
      const res = await api.uploadFile(file);
      if (res.error) throw new Error(res.error);
      setStaged(res);
      setMapping(res.proposed_mapping || {});
      setStage("map");
      await loadHistory();
    } catch (e) { setErr(e); }
    finally { setBusy(false); }
  }

  async function resolve() {
    if (!hasEntityMapping) {
      setErr(new Error("Choose one column to map to entity_name before importing."));
      return;
    }
    setBusy(true); setErr(null);
    try {
      const res = await api.resolveUpload({ upload_id: staged.upload_id, mapping, user_id: "broker" });
      if (res.error) throw new Error(res.error);
      setResult({ ...res, stats: res.stats || {} });
      setStage("done");
      await loadHistory();
      refreshMeta && await refreshMeta();
    } catch (e) { setErr(e); }
    finally { setBusy(false); }
  }

  function reset() { setStage("drop"); setStaged(null); setResult(null); setMapping({}); setErr(null); }

  return (
    <div className="content">
      <div className="view-head">
        <div className="eyebrow">Your book, linked to the market</div>
        <h1>Contacts</h1>
        <p>Upload owners, decision-makers, contact details, property context, and contact history. Exact names and confirmed aliases link automatically. Fuzzy candidates stop in Review so nothing ambiguous is merged blindly.</p>
      </div>

      <ErrorBanner error={err} />

      {stage === "drop" && (
        <div className="panel">
          <label
            className={`drop ${over ? "over" : ""}`}
            onDragOver={(e) => { e.preventDefault(); setOver(true); }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => { e.preventDefault(); setOver(false); handleFile(e.dataTransfer.files[0]); }}
            style={{ display: "block", cursor: "pointer" }}
          >
            <div className="big">Drop a contacts file here</div>
            <div className="small">CSV{IS_RPC_MODE ? "" : " or XLSX"} · Owner, Contact, Role, Phone, Email, Website, Mailing Address, Property, Borough, Asset Type, Last Contact, Notes</div>
            <div style={{ marginTop: 14 }}><span className="btn brass">Choose file</span></div>
            <input type="file" accept={IS_RPC_MODE ? ".csv" : ".csv,.xlsx,.xls"} style={{ display: "none" }} onChange={(e) => handleFile(e.target.files[0])} />
          </label>
          {busy && <Loading label="Reading file…" />}
        </div>
      )}

      {stage === "map" && staged && (
        <div className="panel">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
            <div>
              <strong style={{ fontFamily: "var(--display)", fontSize: 18 }}>{staged.row_count} rows</strong>
              <span style={{ color: "var(--tx-dim)", marginLeft: 10, fontSize: 13 }}>confirm how columns map, then resolve</span>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn ghost" onClick={reset}>Cancel</button>
              <button className="btn brass" onClick={resolve} disabled={busy || !hasEntityMapping}>{busy ? "Resolving…" : "Resolve & import"}</button>
            </div>
          </div>
          <table className="maptable">
            <thead><tr><th>Your column</th><th>Maps to</th><th>Sample</th></tr></thead>
            <tbody>
              {staged.columns.map((col) => (
                <tr key={col}>
                  <td style={{ fontWeight: 600 }}>{col}</td>
                  <td>
                    <select value={mapping[col] || ""} onChange={(e) => setMapping({ ...mapping, [col]: e.target.value })}>
                      {FIELDS.map((f) => <option key={f} value={f}>{f || "— ignore —"}</option>)}
                    </select>
                  </td>
                  <td style={{ color: "var(--tx-dim)", fontFamily: "var(--mono)", fontSize: 12 }}>
                    {staged.sample?.[0]?.[col] ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ marginTop: 10, fontSize: 12.5, color: hasEntityMapping ? "var(--tx-mute)" : "var(--danger)" }}>
            <code>entity_name</code> is required. Property, borough, and asset type improve candidate scoring but never force an automatic fuzzy merge.
          </div>
        </div>
      )}

      {stage === "done" && result && (
        <div className="panel">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 14 }}>
            <strong style={{ fontFamily: "var(--display)", fontSize: 18 }}>Resolution complete</strong>
            <button className="btn brass" onClick={reset}>Upload another</button>
          </div>
          <div className="statgrid">
            <Stat n={result.stats.auto_matched} l="exact-name links" />
            <Stat n={result.stats.alias_matched} l="confirmed-alias links" />
            <Stat n={result.stats.new_entity} l="new entities" />
            <Stat n={result.stats.needs_review} l="sent to review" />
            <Stat n={result.stats.contacts_created} l="contacts created" />
            <Stat n={result.stats.contacts_updated} l="contacts updated" />
            <Stat n={result.stats.interactions_created} l="interactions logged" />
            <Stat n={result.stats.skipped_no_name} l="rejected names" />
          </div>
          {result.stats.needs_review > 0 && (
            <div className="banner warn" style={{ marginTop: 16 }}>
              {result.stats.needs_review} row(s) have plausible fuzzy matches. Open <strong>Review</strong> to select the correct entity, create a new entity, or reject the row. No contact is imported until that decision is made.
            </div>
          )}
        </div>
      )}

      <UploadHistory uploads={history} loading={historyLoading} error={historyErr} onRefresh={loadHistory} />
    </div>
  );
}

function UploadHistory({ uploads, loading, error, onRefresh }) {
  return (
    <section className="panel" style={{ marginTop: 20 }}>
      <div className="panelhead">
        <div>
          <h2>Upload history</h2>
          <p>Every staged file remains auditable with its mapping and row-level outcomes.</p>
        </div>
        <button className="btn ghost sm" onClick={onRefresh} disabled={loading}>{loading ? "Refreshing…" : "Refresh"}</button>
      </div>
      <ErrorBanner error={error} />
      {loading && !uploads && <Loading label="Loading upload history…" />}
      {uploads && uploads.length === 0 && <Empty title="No uploads yet." hint="The first staged contacts file will appear here." />}
      {uploads && uploads.length > 0 && (
        <div className="tablewrap">
          <table className="deals">
            <thead><tr><th>File</th><th>Status</th><th>Created</th><th className="num">Rows</th><th className="num">Imported</th><th className="num">Review</th><th className="num">Rejected</th><th>Mapped fields</th></tr></thead>
            <tbody>{uploads.map((upload) => (
              <tr key={upload.upload_id} style={{ cursor: "default" }}>
                <td><span className="addr">{upload.filename || "Untitled upload"}</span><div style={{ color: "var(--tx-mute)", fontSize: 11 }}>{upload.user_id || "broker"}</div></td>
                <td><Pill kind={uploadStatusKind(upload.status)}>{String(upload.status || "unknown").replaceAll("_", " ")}</Pill></td>
                <td className="money">{shortDate(upload.created_at)}</td>
                <td className="num">{num(upload.row_count ?? upload.staged_rows ?? 0)}</td>
                <td className="num">{num(upload.imported_rows || 0)}</td>
                <td className="num">{upload.open_review_items > 0 ? <Pill kind="review">{num(upload.open_review_items)} open</Pill> : num(upload.needs_review_rows || 0)}</td>
                <td className="num">{num(upload.rejected_rows || 0)}</td>
                <td style={{ maxWidth: 280, color: "var(--tx-dim)", fontSize: 12 }}>{mappedFields(upload.column_mapping)}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function uploadStatusKind(status) {
  if (status === "imported") return "ok";
  if (status === "review_pending" || status === "failed") return "review";
  return "src";
}

function mappedFields(mapping) {
  const fields = [...new Set(Object.values(mapping || {}).filter(Boolean))];
  return fields.length ? fields.join(" · ") : "—";
}

function Stat({ n, l }) {
  return <div className="statbox"><div className="n">{num(n || 0)}</div><div className="l">{l}</div></div>;
}
