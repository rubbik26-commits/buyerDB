import React, { useState, useRef, useEffect } from "react";
import { api, money, num } from "../api/client.js";

const SUGGESTS = [
  "Who's the best buyer for a Brooklyn multifamily around $3M?",
  "What's the phone number for Townhouse Rental II?",
  "Top office buyers by volume",
  "Which buyers are active but have no contact on file?",
  "When did we last contact WB 137?",
];

export default function Agent() {
  const [msgs, setMsgs] = useState([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef(null);

  useEffect(() => { scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight); }, [msgs, busy]);

  async function ask(q) {
    const question = (q ?? input).trim();
    if (!question || busy) return;
    setInput("");
    const history = msgs.filter((m) => m.role === "user" || m.answer).map((m) => ({ role: m.role === "user" ? "user" : "assistant", content: m.role === "user" ? m.text : m.answer }));
    setMsgs((m) => [...m, { role: "user", text: question }]);
    setBusy(true);
    try {
      const res = await api.agent(question, history);
      if (res.error) setMsgs((m) => [...m, { role: "agent", error: res.detail || res.error, hint: res.hint }]);
      else setMsgs((m) => [...m, { role: "agent", tool: res.tool, args: res.arguments, why: res.plan_why, result: res.result, answer: res.answer, providers: res.providers }]);
    } catch (e) {
      setMsgs((m) => [...m, { role: "agent", error: String(e.message || e) }]);
    } finally { setBusy(false); }
  }

  return (
    <div className="agent">
      <div className="agent-scroll" ref={scrollRef}>
        <div className="agent-inner">
          {msgs.length === 0 && (
            <div style={{ paddingTop: 20 }}>
              <div className="eyebrow" style={{ fontFamily: "var(--mono)", fontSize: 10, letterSpacing: "0.24em", textTransform: "uppercase", color: "var(--brass)" }}>Ask the desk</div>
              <h1 style={{ fontFamily: "var(--display)", fontSize: 30, fontWeight: 600, margin: "7px 0 8px" }}>Deal Desk</h1>
              <p style={{ color: "var(--tx-dim)", fontSize: 14, maxWidth: "60ch" }}>Ask in plain language. The desk translates your question into a database query, runs it, and answers from the rows. Contact details come only from records on file; it never invents a phone number.</p>
              <div className="suggests">{SUGGESTS.map((s) => <span key={s} className="suggest" onClick={() => ask(s)}>{s}</span>)}</div>
            </div>
          )}
          {msgs.map((m, i) => (
            <div key={i} className={`msg ${m.role}`}>
              <div className="who">{m.role === "user" ? "You" : "Deal Desk"}</div>
              {m.role === "user" ? <div className="bubble">{m.text}</div> : m.error ? (
                <div className="bubble"><div className="banner err" style={{ margin: 0 }}>The desk could not complete that request. {m.hint || ""}<div style={{ marginTop: 6, fontFamily: "var(--mono)", fontSize: 11 }}>{m.error}</div></div></div>
              ) : (
                <div className="bubble">
                  {m.tool && <div className="trace"><div className="th">Query plan{m.providers?.plan ? ` · ${m.providers.plan}` : ""}</div><div className="tool">{m.tool}()</div>{m.args && Object.keys(m.args).length > 0 && <div className="args">{JSON.stringify(m.args)}</div>}</div>}
                  <div style={{ whiteSpace: "pre-wrap" }}>{m.answer}</div>
                  <Citations result={m.result} />
                </div>
              )}
            </div>
          ))}
          {busy && <div className="msg agent"><div className="who">Deal Desk</div><div className="bubble" style={{ color: "var(--tx-dim)" }}><span className="spinner" /> querying...</div></div>}
        </div>
      </div>
      <div className="agent-input"><div className="row"><textarea value={input} onChange={(e) => setInput(e.target.value)} placeholder="Ask about buyers, owners, contacts, or recent deals..." onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask(); } }} /><button className="btn brass" onClick={() => ask()} disabled={busy || !input.trim()}>Ask</button></div></div>
    </div>
  );
}

function buyerMeta(c) {
  const deals = c.deal_count ?? c.n ?? c.deals ?? 0;
  const volume = c.volume ?? c.vol ?? 0;
  return `${num(deals)} deals · ${money(volume, true)}${c.is_spv_suspect ? " · SPV" : ""}${c.has_contact ? " · contact" : ""}`;
}

function Citations({ result }) {
  if (!result) return null;
  const rows = [];
  if (result.candidates) result.candidates.slice(0, 6).forEach((c) => rows.push({ nm: c.name, meta: buyerMeta(c) }));
  else if (result.leaders) result.leaders.slice(0, 6).forEach((c) => rows.push({ nm: c.name, meta: buyerMeta(c) }));
  else if (result.matches) { result.matches.forEach((mm) => (mm.contacts || []).forEach((c) => rows.push({ nm: mm.name, meta: `${c.phone || "no phone"} · ${c.email || "no email"} · ${c.source || "source unknown"}` }))); rows.splice(6); }
  else if (result.sellers) result.sellers.slice(0, 6).forEach((c) => rows.push({ nm: c.name, meta: `${num(c.sales || c.n || 0)} sales · ${money(c.vol || c.volume || 0, true)}` }));
  else if (result.entities_missing_contact) result.entities_missing_contact.slice(0, 6).forEach((c) => rows.push({ nm: c.name, meta: `${num(c.deals || c.n || c.deal_count || 0)} deals · ${money(c.vol || c.volume || 0, true)} · no contact` }));
  else if (result.deals) result.deals.slice(0, 6).forEach((c) => rows.push({ nm: c.address, meta: `${c.asset_type || ""} · ${money(c.sale_price, true)}` }));
  if (rows.length === 0) return null;
  return <div className="citelist">{rows.map((r, i) => <div className="cite" key={i}><span className="nm">{r.nm}</span><span className="mono">{r.meta}</span></div>)}</div>;
}
