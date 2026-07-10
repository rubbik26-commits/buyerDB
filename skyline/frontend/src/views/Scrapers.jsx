import React, { useEffect, useState } from "react";
import { api, shortDate } from "../api/client.js";
import { Empty, ErrorBanner, Loading, Pill } from "../components/ui.jsx";

const JOBS = [
  { id: "traded_refresh", label: "Traded refresh", note: "Discover and parse new New York sale pages, subtract the fetch ledger, then merge through the canonical write path." },
  { id: "acris_refresh", label: "ACRIS refresh", note: "Ingest the fresh deed window with PLUTO classification and deed-backed party evidence." },
  { id: "crexi_refresh", label: "Crexi refresh", note: "Run the configured Apify actor, retain active-listing provenance, and ingest broker contacts." },
  { id: "rolling_sales", label: "Rolling Sales enrichment", note: "Fill units and square footage only when all matching city rows agree; conflicts go to Review." },
  { id: "phase2_enrichment", label: "ACRIS party-lag enrichment", note: "Match missing parties and apply them only through the validated 3% amount gate." },
  { id: "dos_enrich", label: "NYS DOS enrichment", note: "Fill entity mailing addresses and real key-person records while filtering registered-agent mills." },
  { id: "property_owner_refresh", label: "Owner/contact refresh", note: "Run the amount-gated party-lag and NYS DOS enrichment paths together." },
  { id: "full_refresh", label: "Full refresh", note: "Dispatch ACRIS, Traded, Crexi, Rolling Sales, and owner/contact enrichment as separate auditable runs." },
];

export default function Scrapers() {
  const [runs, setRuns] = useState(null);
  const [err, setErr] = useState(null);
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [job, setJob] = useState("traded_refresh");
  const [requesting, setRequesting] = useState(false);

  const load = () => {
    setLoading(true);
    setErr(null);
    api.scraperRuns({ limit: 100 })
      .then((data) => {
        if (data?.error) throw new Error(data.error);
        setRuns(data.runs || []);
      })
      .catch(setErr)
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  async function requestRun() {
    setRequesting(true);
    setErr(null);
    setNotice("");
    try {
      const response = await api.requestScrape({ job, user_id: "broker", options: { requested_from: "scraper_operations_ui" } });
      if (response?.error) throw new Error(response.detail || response.error);
      const count = response.runs?.length || 1;
      setNotice(`${count} ${count === 1 ? "job" : "jobs"} dispatched to the server-side background runtime.`);
      window.setTimeout(load, 1200);
    } catch (error) {
      setErr(error);
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
          Netlify provides the scheduled control plane and long-running background execution;
          Supabase stores the queue, ledgers, canonical rows, review items, and run evidence.
          GitHub is source control only and does not execute production scraper jobs.
        </p>
      </div>

      <ErrorBanner error={err} />
      {notice && <div className="banner ok" style={{ marginBottom: 14 }}>{notice}</div>}

      <div className="workgrid two" style={{ marginBottom: 18 }}>
        <section className="panel">
          <div className="panelhead">
            <div>
              <h2>Run a refresh</h2>
              <p>Creates an auditable run row and immediately dispatches the selected server-side job.</p>
            </div>
          </div>
          <div className="panelbody">
            <div className="filters" style={{ boxShadow: "none", margin: 0 }}>
              <div className="field" style={{ minWidth: 240 }}>
                <label>Job</label>
                <select value={job} onChange={(event) => setJob(event.target.value)}>
                  {JOBS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
                </select>
              </div>
              <div className="spacer" />
              <button className="btn brass" disabled={requesting} onClick={requestRun}>{requesting ? "Dispatching…" : "Run now"}</button>
            </div>
            <div className="scraper-notes">
              {JOBS.map((item) => (
                <div key={item.id} className={item.id === job ? "on" : ""}>
                  <strong>{item.label}</strong>
                  <span>{item.note}</span>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="panel">
          <div className="panelhead">
            <div>
              <h2>Non-negotiable gates</h2>
              <p>The same correctness rules apply to scheduled, manual, uploaded, and cross-source data.</p>
            </div>
          </div>
          <div className="panelbody rules">
            <div><Pill kind="ok">exclude</Pill><span>No condos, co-ops, single-family, two-family, or 1–2 family records.</span></div>
            <div><Pill kind="ok">amount gate</Pill><span>ACRIS parties require deed evidence and the validated price/date gate.</span></div>
            <div><Pill kind="ok">ledger</Pill><span>Every discovery disposition is durable; every merge checks exclusions and duplicate keys.</span></div>
            <div><Pill kind="review">review</Pill><span>Source conflicts, ambiguous parties, and Rolling Sales disagreements are never silently resolved.</span></div>
          </div>
        </section>
      </div>

      {loading && !runs ? <Loading label="Loading scraper runs…" /> : null}
      {runs && runs.length === 0 ? <Empty title="No scraper runs yet." hint="Run a refresh to create the first auditable job." /> : null}

      {runs && runs.length > 0 && (
        <div className="tablewrap">
          <table className="deals">
            <thead><tr><th>Job</th><th>Status</th><th>Started</th><th>Finished</th><th>Stats / Error</th></tr></thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.run_id} style={{ cursor: "default" }}>
                  <td><span className="addr">{run.job}</span></td>
                  <td><Pill kind={pillKind(run.status)}>{run.status || "unknown"}</Pill></td>
                  <td className="money">{shortDate(run.started_at)}</td>
                  <td className="money">{shortDate(run.finished_at)}</td>
                  <td>{run.error ? <span style={{ color: "var(--danger)" }}>{run.error}</span> : <code>{compactStats(run.stats)}</code>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ marginTop: 16 }}><button className="btn ghost" onClick={load}>Refresh runs</button></div>
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
    const entries = Object.entries(stats).filter(([, value]) => value !== null && value !== undefined);
    return entries.length ? entries.map(([key, value]) => `${key}: ${typeof value === "object" ? JSON.stringify(value) : value}`).join(" · ").slice(0, 220) : "—";
  } catch { return "—"; }
}
