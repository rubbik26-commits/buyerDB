import React, { useEffect, useState } from "react";
import { api, money, num, shortDate } from "../api/client.js";
import { Empty, ErrorBanner, Loading, Pill } from "../components/ui.jsx";

const EMPTY = { asset_type: "", borough: "", price_min: "", price_max: "", require_email: false };

export default function Outreach({ meta }) {
  const [f, setF] = useState(EMPTY);
  const [applied, setApplied] = useState(EMPTY);
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState(null);
  const [summary, setSummary] = useState("");
  const [draft, setDraft] = useState(null);
  const [drafting, setDrafting] = useState(false);

  const load = () => {
    setLoading(true);
    setErr(null);
    api.outreachTargets({ ...applied, require_email: applied.require_email ? "true" : "", limit: 75 })
      .then((d) => { if (d?.error) throw new Error(d.error); setData(d); })
      .catch(setErr)
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, [applied]);

  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value });
  const apply = () => setApplied(f);
  const reset = () => { setF(EMPTY); setApplied(EMPTY); };

  async function createDraft(target) {
    setSelected(target);
    setDraft(null);
    setDrafting(true);
    setErr(null);
    try {
      const res = await api.outreachDraft({ entity_id: target.entity_id, property_summary: summary });
      if (res?.error) throw new Error(res.error);
      setDraft(res);
    } catch (e) { setErr(e); }
    finally { setDrafting(false); }
  }

  const targets = data?.targets || [];
  return (
    <div className="content">
      <div className="view-head">
        <div className="eyebrow">Outreach center</div>
        <h1>Buyer outreach</h1>
        <p>Build buyer target lists from actual track record and generate broker-reviewed drafts. The system does not send email or invent contact info.</p>
      </div>
      <div className="filters">
        <div className="field"><label>Asset type</label><select value={f.asset_type} onChange={set("asset_type")}><option value="">All</option>{(meta.asset_types || []).map((a) => <option key={a}>{a}</option>)}</select></div>
        <div className="field"><label>Borough</label><select value={f.borough} onChange={set("borough")}><option value="">All</option>{(meta.boroughs || []).map((b) => <option key={b}>{b}</option>)}</select></div>
        <div className="field narrow"><label>Price min</label><input value={f.price_min} onChange={set("price_min")} placeholder="$" inputMode="numeric" /></div>
        <div className="field narrow"><label>Price max</label><input value={f.price_max} onChange={set("price_max")} placeholder="$" inputMode="numeric" /></div>
        <div className="field"><label>Email only</label><div className="chip-row"><span className={`chip ${f.require_email ? "on" : ""}`} onClick={() => setF({ ...f, require_email: !f.require_email })}>{f.require_email ? "email required" : "any contact"}</span></div></div>
        <div className="field" style={{ minWidth: 280 }}><label>Property / opportunity summary</label><input value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="e.g. Manhattan mixed-use, ~$20M, off-market" /></div>
        <div className="spacer" />
        <button className="btn" onClick={apply}>Find targets</button>
        <button className="btn ghost" onClick={reset}>Reset</button>
      </div>
      <ErrorBanner error={err} />
      {loading && !data ? <Loading label="Loading target buyers…" /> : null}
      <div className="workgrid two">
        <section className="panel">
          <div className="panelhead"><h2>Target buyers</h2><p>{num(targets.length)} buyers ranked by filtered transaction volume.</p></div>
          <div className="panelbody">
            {targets.length === 0 ? <Empty title="No outreach targets found." /> : targets.map((t) => (
              <button className="workitem" key={t.entity_id} onClick={() => createDraft(t)}>
                <div><strong>{t.name}</strong><span>{num(t.deal_count)} deals · {money(t.volume, true)} · emails {num(t.email_count)} · last {shortDate(t.last_deal)}</span></div>
                <Pill kind={t.email_count > 0 ? "ok" : "review"}>{t.email_count > 0 ? "email" : "no email"}</Pill>
              </button>
            ))}
          </div>
        </section>
        <section className="panel">
          <div className="panelhead"><h2>Draft</h2><p>{selected ? selected.name : "Select a buyer to generate a draft."}</p></div>
          <div className="panelbody">
            {drafting && <Loading label="Drafting…" />}
            {!drafting && !draft && <Empty title="No draft selected." hint="Choose a target buyer from the left." />}
            {draft && (
              <div className="draftbox">
                <div className="field"><label>Subject</label><input readOnly value={draft.subject || ""} /></div>
                <div className="field"><label>Body</label><textarea className="notearea" readOnly value={draft.body || ""} /></div>
                <div className="field"><label>Contacts on file</label></div>
                {(draft.contacts || []).length === 0 ? <div className="banner warn">No email/phone on file for this buyer.</div> : draft.contacts.map((c, i) => <div className="cite" key={i}><span className="nm">{c.person_name || draft.entity?.display_name || "contact"}</span><span className="mono">{c.email || "no email"} · {c.phone || "no phone"} · {c.source}</span></div>)}
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
