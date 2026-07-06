import React, { useState } from "react";
import { api, num } from "../api/client.js";
import { Loading, ErrorBanner } from "../components/ui.jsx";

const FIELDS = ["", "entity_name", "person_name", "phone", "email", "mailing_address", "title", "last_contact_date", "interaction_notes", "channel"];

export default function Uploads({ refreshMeta }) {
  const [stage, setStage] = useState("drop"); // drop | map | done
  const [over, setOver] = useState(false);
  const [staged, setStaged] = useState(null);
  const [mapping, setMapping] = useState({});
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  async function handleFile(file) {
    if (!file) return;
    setBusy(true); setErr(null);
    try {
      const res = await api.uploadFile(file);
      if (res.error) throw new Error(res.error);
      setStaged(res);
      setMapping(res.proposed_mapping || {});
      setStage("map");
    } catch (e) { setErr(e); }
    finally { setBusy(false); }
  }

  async function resolve() {
    setBusy(true); setErr(null);
    try {
      const res = await api.resolveUpload({ upload_id: staged.upload_id, mapping, user_id: "broker" });
      if (res.error) throw new Error(res.error);
      setResult(res);
      setStage("done");
      refreshMeta && refreshMeta();
    } catch (e) { setErr(e); }
    finally { setBusy(false); }
  }

  function reset() { setStage("drop"); setStaged(null); setResult(null); setMapping({}); setErr(null); }

  return (
    <div className="content">
      <div className="view-head">
        <div className="eyebrow">Your book, linked to the market</div>
        <h1>Contacts</h1>
        <p>Drop a CSV or Excel of owners, phones, emails, and call history. The desk normalizes each name, links it to the buyers and sellers already in the dataset, and holds anything ambiguous for your review — nothing is merged blindly.</p>
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
            <div className="small">CSV or XLSX · columns like Owner, Phone, Email, Address, Last Contacted, Notes</div>
            <div style={{ marginTop: 14 }}><span className="btn brass">Choose file</span></div>
            <input type="file" accept=".csv,.xlsx,.xls" style={{ display: "none" }} onChange={(e) => handleFile(e.target.files[0])} />
          </label>
          {busy && <Loading label="Reading file…" />}
        </div>
      )}

      {stage === "map" && staged && (
        <div className="panel">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <div>
              <strong style={{ fontFamily: "var(--display)", fontSize: 18 }}>{staged.row_count} rows</strong>
              <span style={{ color: "var(--tx-dim)", marginLeft: 10, fontSize: 13 }}>confirm how columns map, then import</span>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn ghost" onClick={reset}>Cancel</button>
              <button className="btn brass" onClick={resolve} disabled={busy}>{busy ? "Importing…" : "Resolve & import"}</button>
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
          <div style={{ marginTop: 10, fontSize: 12.5, color: "var(--tx-mute)" }}>
            An <code>entity_name</code> column is required — it's what links a contact to a buyer or seller.
          </div>
        </div>
      )}

      {stage === "done" && result && (
        <div className="panel">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
            <strong style={{ fontFamily: "var(--display)", fontSize: 18 }}>Import complete</strong>
            <button className="btn brass" onClick={reset}>Upload another</button>
          </div>
          <div className="statgrid">
            <Stat n={result.stats.auto_matched} l="linked to existing" />
            <Stat n={result.stats.new_entity} l="new owners" />
            <Stat n={result.stats.needs_review} l="sent to review" />
            <Stat n={result.stats.contacts_created} l="contacts saved" />
            <Stat n={result.stats.interactions_created} l="interactions logged" />
            <Stat n={result.stats.skipped_no_name} l="skipped (no name)" />
          </div>
          {result.stats.needs_review > 0 && (
            <div className="banner warn" style={{ marginTop: 16 }}>
              {result.stats.needs_review} row(s) matched an existing owner only fuzzily. Open <strong>Review</strong> to confirm or reject each — they won't be merged until you do.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Stat({ n, l }) {
  return <div className="statbox"><div className="n">{num(n || 0)}</div><div className="l">{l}</div></div>;
}
