import React, { useEffect, useState } from "react";
import { api, money, num, shortDate } from "../api/client.js";
import { Empty, EntityDrawer, ErrorBanner, Loading, Pill } from "../components/ui.jsx";

export default function Workbench({ refreshMeta }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);
  const [drawer, setDrawer] = useState(null);

  const load = () => {
    setLoading(true);
    setErr(null);
    api.workbench()
      .then((d) => {
        if (d?.error) throw new Error(d.error);
        setData(d);
      })
      .catch(setErr)
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  const s = data?.stats || {};

  return (
    <div className="content">
      <div className="view-head">
        <div className="eyebrow">Combined system</div>
        <h1>Broker command center</h1>
        <p>
          The buyerDB engine and dealflow workflow in one place: live deal coverage,
          owner targets, contact gaps, review items, scraper status, and the next broker actions.
        </p>
      </div>

      <ErrorBanner error={err} />
      {loading && !data ? <Loading label="Loading broker workflow…" /> : null}
      {!loading && !err && !data ? <Empty title="No workbench data returned." /> : null}

      {data && (
        <>
          <div className="workgrid kpis">
            <Metric label="Closed deals" value={num(s.deals)} />
            <Metric label="Total volume" value={money(s.total_volume, true)} accent />
            <Metric label="Unique buyers" value={num(s.unique_buyers)} />
            <Metric label="Contacts" value={num(s.contacts)} />
            <Metric label="Contact gaps" value={num(s.contact_gaps)} warn />
            <Metric label="Open review" value={num(s.open_reviews)} warn />
          </div>

          <div className="workgrid two">
            <Panel title="High-value contact gaps" subtitle="Active buyers with real transaction history but no phone/email uploaded yet.">
              {(data.contact_gaps || []).length === 0 ? <Empty title="No contact gaps found." /> :
                data.contact_gaps.map((r) => (
                  <button className="workitem" key={r.entity_id} onClick={() => setDrawer(r.entity_id)}>
                    <div>
                      <strong>{r.name}</strong>
                      <span>{num(r.deal_count)} deals · {money(r.volume, true)} volume · last {shortDate(r.last_deal)}</span>
                    </div>
                    <Pill kind="review">missing contact</Pill>
                  </button>
                ))}
            </Panel>

            <Panel title="Property / owner targets" subtitle="Latest buyer is treated as the best known owner from the transaction ledger.">
              {(data.owner_targets || []).length === 0 ? <Empty title="No owner targets found." /> :
                data.owner_targets.map((r) => (
                  <button className="workitem" key={r.property_id} onClick={() => r.owner_entity_id && setDrawer(r.owner_entity_id)}>
                    <div>
                      <strong>{r.address}</strong>
                      <span>{r.known_owner || "owner unknown"} · {r.borough || "—"} · {money(r.sale_price, true)}</span>
                    </div>
                    <Pill kind={r.has_contact ? "ok" : "review"}>{r.has_contact ? "contact" : "gap"}</Pill>
                  </button>
                ))}
            </Panel>
          </div>

          <div className="workgrid two">
            <Panel title="Review queue" subtitle="Merge/entity/parse issues that need broker judgment before data is trusted.">
              {(data.review_items || []).length === 0 ? <Empty title="No open review items." /> :
                data.review_items.map((r) => (
                  <div className="workitem static" key={r.review_id}>
                    <div>
                      <strong>{r.issue_class}</strong>
                      <span>{r.object_type} · {r.object_id} · {shortDate(r.created_at)}</span>
                    </div>
                    <Pill kind="review">{r.severity || "normal"}</Pill>
                  </div>
                ))}
            </Panel>

            <Panel title="Scraper / ingestion runs" subtitle="Visibility into scheduled or manual Traded, ACRIS, Crexi, and full-refresh jobs.">
              {(data.scrape_runs || []).length === 0 ? <Empty title="No scraper runs logged yet." /> :
                data.scrape_runs.map((r) => (
                  <div className="workitem static" key={r.run_id}>
                    <div>
                      <strong>{r.job}</strong>
                      <span>{shortDate(r.started_at)} · {r.finished_at ? `finished ${shortDate(r.finished_at)}` : "not finished"}</span>
                    </div>
                    <Pill kind={r.status === "completed" ? "ok" : r.status === "failed" ? "review" : "src"}>{r.status || "unknown"}</Pill>
                  </div>
                ))}
            </Panel>
          </div>

          <div style={{ display: "flex", gap: 8, marginTop: 18 }}>
            <button className="btn" onClick={load}>Refresh workbench</button>
            <button className="btn ghost" onClick={refreshMeta}>Refresh headline stats</button>
          </div>
        </>
      )}

      <EntityDrawer entityId={drawer} onClose={() => setDrawer(null)} />
    </div>
  );
}

function Metric({ label, value, accent, warn }) {
  return (
    <div className={`metric ${accent ? "accent" : ""} ${warn ? "warn" : ""}`}>
      <div className="k">{label}</div>
      <div className="v">{value}</div>
    </div>
  );
}

function Panel({ title, subtitle, children }) {
  return (
    <section className="panel">
      <div className="panelhead">
        <div>
          <h2>{title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
      </div>
      <div className="panelbody">{children}</div>
    </section>
  );
}
