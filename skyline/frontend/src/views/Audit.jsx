import React, { useEffect, useState } from "react";
import { api, money, num, shortDate } from "../api/client.js";
import { Empty, ErrorBanner, Loading, Pill } from "../components/ui.jsx";

export default function Audit() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);
  const [fixing, setFixing] = useState(false);
  const [fixResult, setFixResult] = useState(null);

  const load = () => {
    setLoading(true);
    setErr(null);
    api.audit()
      .then((d) => { if (d?.error) throw new Error(d.error); setData(d); })
      .catch(setErr)
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

  async function fixStaleRuns() {
    setFixing(true);
    setErr(null);
    try {
      const res = await api.fixStaleRuns();
      if (res?.error) throw new Error(res.error);
      setFixResult(res);
      load();
    } catch (e) { setErr(e); }
    finally { setFixing(false); }
  }

  const totals = data?.totals || {};
  return (
    <div className="content">
      <div className="view-head">
        <div className="eyebrow">Admin audit</div>
        <h1>Data health & cleanup</h1>
        <p>Read-only health panels for duplicates, missing parties, contact gaps, failed runs, and problem imports. Cleanup actions are explicit and non-destructive.</p>
      </div>
      <ErrorBanner error={err} />
      {fixResult && <div className="banner ok">Marked {num(fixResult.count)} stale scraper run(s) as timeout.</div>}
      {loading && !data ? <Loading label="Running audit…" /> : null}
      {data && (
        <>
          <div className="workgrid kpis">
            <Metric label="Properties" value={num(totals.properties)} />
            <Metric label="Deals" value={num(totals.deals)} />
            <Metric label="Entities" value={num(totals.entities)} />
            <Metric label="Contacts" value={num(totals.contacts)} />
            <Metric label="Open review" value={num(totals.open_reviews)} warn />
            <Metric label="Failed scrapes" value={num(totals.failed_scrapes)} warn />
          </div>
          <div className="workgrid two">
            <AuditPanel title="Duplicate properties" rows={data.duplicate_properties} empty="No duplicate property identities found.">{(r) => <><strong>{r.address_norm}</strong><span>{r.borough || "—"} · {num(r.n)} rows</span></>}</AuditPanel>
            <AuditPanel title="Duplicate deal keys" rows={data.duplicate_deals} empty="No duplicate deal keys found.">{(r) => <><strong>{r.address}</strong><span>{r.borough || "—"} · {money(r.sale_price, true)} · {shortDate(r.sale_date)} · {num(r.n)} rows</span></>}</AuditPanel>
          </div>
          <div className="workgrid two">
            <AuditPanel title="Missing buyer/seller parties" rows={data.missing_parties} empty="No missing party gaps found.">{(r) => <><strong>{r.address}</strong><span>{r.borough || "—"} · {r.asset_type || "—"} · buyer {r.has_buyer ? "yes" : "missing"} · seller {r.has_seller ? "yes" : "missing"}</span></>}</AuditPanel>
            <AuditPanel title="Contact gaps" rows={data.contact_gaps} empty="No high-value contact gaps found.">{(r) => <><strong>{r.name}</strong><span>{num(r.deal_count)} deals · {money(r.volume, true)} · last {shortDate(r.last_deal)}</span></>}</AuditPanel>
          </div>
          <div className="workgrid two">
            <section className="panel">
              <div className="panelhead"><h2>Problem scraper runs</h2><p>Failed, timeout, quota-blocked, completed-with-errors, or still running.</p></div>
              <div className="panelbody">
                {(data.problem_runs || []).length === 0 ? <Empty title="No problem runs found." /> : data.problem_runs.map((r) => (
                  <div className="workitem static" key={r.run_id}><div><strong>{r.job}</strong><span>{shortDate(r.started_at)} · {String(r.error || "no error text").slice(0, 140)}</span></div><Pill kind={r.status === "running" ? "src" : "review"}>{r.status}</Pill></div>
                ))}
                <button className="btn ghost" disabled={fixing} onClick={fixStaleRuns}>{fixing ? "Fixing…" : "Mark stale running jobs as timeout"}</button>
              </div>
            </section>
            <AuditPanel title="Problem uploads" rows={data.problem_uploads} empty="No problem uploads found.">{(r) => <><strong>{r.filename || "upload"}</strong><span>{r.status} · {num(r.row_count)} rows · {shortDate(r.created_at)}</span></>}</AuditPanel>
          </div>
          <div style={{ marginTop: 16 }}><button className="btn" onClick={load}>Refresh audit</button></div>
        </>
      )}
    </div>
  );
}

function Metric({ label, value, warn }) {
  return <div className={`metric ${warn ? "warn" : ""}`}><div className="k">{label}</div><div className="v">{value}</div></div>;
}

function AuditPanel({ title, rows, empty, children }) {
  return <section className="panel"><div className="panelhead"><h2>{title}</h2></div><div className="panelbody">{(rows || []).length === 0 ? <Empty title={empty} /> : rows.map((r, i) => <div className="workitem static" key={r.review_id || r.entity_id || r.deal_id || r.upload_id || `${title}-${i}`}><div>{children(r)}</div></div>)}</div></section>;
}
