import React, { useEffect, useState } from "react";
import { api, shortDate } from "../api/client.js";
import { Empty, ErrorBanner, Loading, Pill } from "../components/ui.jsx";

const JOBS = [
  { id: "traded_refresh", label: "Traded refresh", note: "Refresh commercial sale pages and merge into canonical deals." },
  { id: "acris_refresh", label: "ACRIS refresh", note: "Refresh deed-backed NYC sales with amount-gate protection." },
  { id: "crexi_refresh", label: "Crexi refresh", note: "Refresh public listing/deal intelligence where configured." },
  { id: "property_owner_refresh", label: "Owner/contact refresh", note: "Re-run owner/contact gap enrichment workflow." },
  { id: "full_refresh", label: "Full refresh", note: "Queue every configured ingestion source." },
];

export default function Scrapers() {
  const [runs, setRuns] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);
  const [job, setJob] = useState("traded_refresh");
  const [requesting, setRequesting] = useState(false);

  const load = () => {
    setLoading(true);
    setErr(null);
    api.scraperRuns({ limit: 75 })
      .then((d) => {
        if (d?.error) throw new Error(d.error);
        setRuns(d.runs || []);
      })
      .catch(setErr)
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  async function requestRun() {
    setRequesting(true);
    setErr(null);
    try {
      const res = await api.requestScrape({ job, user_id: "broker", options: { requested_from: "scraper_operations_ui" } });
      if (res?.error) throw new Error(res.error);
      load();
    } catch (e) {
      setErr(e);
    } finally {
      setRequesting(false);
    }
  }

  return (
    <div className="content">
      <div className="view-head">
        <div className="eyebrow">Ingestion operations</div>
        <h1>Scrapers & scheduled refresh</h1>
        <p>
          A broker-facing control room for Traded, ACRIS, Crexi, owner/contact refresh,
          and full database refresh jobs. Manual requests are logged into scrape_runs for
          the worker/scheduler to claim instead of pretending a long scraper ran in the browser.
        </p>
      </div>

      <ErrorBanner error={err} />

      <div className="workgrid two" style={{ marginBottom: 18 }}>
        <section className="panel">
          <div className="panelhead">
            <div>
              <h2>Request a refresh</h2>
              <p>Creates a durable run request that the backend worker can execute and audit.</p>
            </div>
          </div>
          <div className="panelbody">
            <div className="filters" style={{ boxShadow: "none", margin: 0 }}>
              <div className="field" style={{ minWidth: 240 }}>
                <label>Job</label>
                <select value={job} onChange={(e) => setJob(e.target.value)}>
                  {JOBS.map((j) => <option key={j.id} value={j.id}>{j.label}</option>)}
                </select>
              </div>
              <div className="spacer" />
              <button className="btn brass" disabled={requesting} onClick={requestRun}>{requesting ? "Requesting…" : "Request run"}</button>
            </div>
            <div className="scraper-notes">
              {JOBS.map((j) => (
                <div key={j.id} className={j.id === job ? "on" : ""}>
                  <strong>{j.label}</strong>
                  <span>{j.note}</span>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="panel">
          <div className="panelhead">
            <div>
              <h2>Run rules</h2>
              <p>These are the non-negotiable gates inherited from buyerDB and the dealflow scraper logic.</p>
            </div>
          </div>
          <div className="panelbody rules">
            <div><Pill kind="ok">gate</Pill><span>No condos, co-ops, single-family, two-family, or 1–2 family.</span></div>
            <div><Pill kind="ok">gate</Pill><span>Commercial sale records below the price/scale floor are excluded.</span></div>
            <div><Pill kind="ok">provenance</Pill><span>Source system, source URL, run status, and errors stay visible.</span></div>
            <div><Pill kind="review">review</Pill><span>Ambiguous entities and parsing conflicts go to the review queue.</span></div>
          </div>
        </section>
      </div>

      {loading && !runs ? <Loading label="Loading scraper runs…" /> : null}
      {runs && runs.length === 0 ? <Empty title="No scraper runs yet." hint="Request a refresh to create the first run row." /> : null}

      {runs && runs.length > 0 && (
        <div className="tablewrap">
          <table className="deals">
            <thead>
              <tr>
                <th>Job</th>
                <th>Status</th>
                <th>Started</th>
                <th>Finished</th>
                <th>Stats / Error</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.run_id} style={{ cursor: "default" }}>
                  <td><span className="addr">{r.job}</span></td>
                  <td><Pill kind={pillKind(r.status)}>{r.status || "unknown"}</Pill></td>
                  <td className="money">{shortDate(r.started_at)}</td>
                  <td className="money">{shortDate(r.finished_at)}</td>
                  <td>
                    {r.error ? <span style={{ color: "var(--danger)" }}>{r.error}</span> : <code>{compactStats(r.stats)}</code>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ marginTop: 16 }}>
        <button className="btn ghost" onClick={load}>Refresh runs</button>
      </div>
    </div>
  );
}

function pillKind(status) {
  if (status === "completed") return "ok";
  if (["failed", "timeout", "quota_blocked", "completed_with_errors"].includes(status)) return "review";
  return "src";
}

function compactStats(stats) {
  if (!stats) return "—";
  if (typeof stats === "string") return stats.length > 120 ? stats.slice(0, 120) + "…" : stats;
  try {
    const keys = Object.entries(stats).filter(([, v]) => v !== null && v !== undefined);
    return keys.length ? keys.map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`).join(" · ").slice(0, 180) : "—";
  } catch {
    return "—";
  }
}
