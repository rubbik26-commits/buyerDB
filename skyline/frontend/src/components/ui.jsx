import React, { useEffect, useState } from "react";
import { api, money, shortDate } from "../api/client.js";

export function Pill({ kind, children }) { return <span className={`pill ${kind || "src"}`}>{children}</span>; }
export function Loading({ label = "Loading..." }) { return <div className="loading"><span className="spinner" /> {label}</div>; }
export function Empty({ title, hint }) { return <div className="empty"><div className="big">{title}</div>{hint && <div>{hint}</div>}</div>; }
export function ErrorBanner({ error }) { if (!error) return null; return <div className="banner err">{String(error.message || error)}</div>; }

function websiteHref(value) {
  if (!value) return null;
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

function phoneHref(value) {
  if (!value) return null;
  const normalized = String(value).replace(/[^0-9+]/g, "");
  return normalized ? `tel:${normalized}` : null;
}

function ContactRecord({ contact }) {
  const name = contact.person_name || contact.company || "Entity contact";
  const web = websiteHref(contact.website);
  const tel = phoneHref(contact.phone);
  return (
    <div className="cite" style={{ display: "block", marginBottom: 9, padding: "11px 12px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap", marginBottom: 5 }}>
        <span className="nm">{name}</span>
        {contact.role && <Pill kind="src">{contact.role}</Pill>}
        {contact.is_primary && <Pill kind="ok">primary</Pill>}
      </div>
      <div className="mono" style={{ display: "grid", gap: 4, overflowWrap: "anywhere" }}>
        {contact.phone && <div><span style={{ color: "var(--tx-mute)" }}>Phone · </span>{tel ? <a href={tel}>{contact.phone}</a> : contact.phone}</div>}
        {contact.email && <div><span style={{ color: "var(--tx-mute)" }}>Email · </span><a href={`mailto:${contact.email}`}>{contact.email}</a></div>}
        {contact.website && <div><span style={{ color: "var(--tx-mute)" }}>Website · </span><a href={web} target="_blank" rel="noreferrer">{contact.website}</a></div>}
        {contact.mailing_address && <div><span style={{ color: "var(--tx-mute)" }}>Mailing · </span>{contact.mailing_address}</div>}
        <div style={{ color: "var(--tx-mute)", fontSize: 10 }}>Source · {contact.source || "unknown"}{contact.confidence != null ? ` · confidence ${contact.confidence}` : ""}</div>
      </div>
    </div>
  );
}

export function EntityDrawer({ entityId, onClose }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    if (!entityId) return;
    setData(null); setErr(null);
    let stale = false;
    api.entity(entityId).then((d) => { if (!stale) setData({ entity: d.entity || null, contacts: d.contacts || [], deals: d.deals || [] }); }).catch((e) => { if (!stale) setErr(e); });
    return () => { stale = true; };
  }, [entityId]);
  useEffect(() => { if (!entityId) return; const onKey = (e) => { if (e.key === "Escape") onClose(); }; window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey); }, [entityId, onClose]);
  if (!entityId) return null;
  const contacts = data?.contacts || [];
  const deals = data?.deals || [];
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(18,22,31,0.45)", zIndex: 50, display: "flex", justifyContent: "flex-end" }} onClick={onClose}>
      <div style={{ width: "min(600px, 94vw)", background: "var(--paper)", height: "100%", overflowY: "auto", boxShadow: "var(--shadow-lg)", padding: "24px 26px" }} onClick={(e) => e.stopPropagation()}>
        <button className="btn ghost sm" onClick={onClose} style={{ float: "right" }}>Close</button>
        <ErrorBanner error={err} />
        {!data && !err && <Loading />}
        {data && !data.entity && <Empty title="Entity not found." />}
        {data && data.entity && <>
          <div className="view-head" style={{ marginBottom: 14 }}><div className="eyebrow">{data.entity.entity_type || "entity"}{data.entity.is_spv_suspect ? " · single-purpose LLC" : ""}</div><h1 style={{ fontSize: 24 }}>{data.entity.display_name}</h1>{data.entity.mailing_address && <p style={{ marginTop: 5 }}>{data.entity.mailing_address}</p>}</div>
          <div className="th" style={{ fontFamily: "var(--mono)", fontSize: 10, letterSpacing: "0.16em", textTransform: "uppercase", color: "var(--tx-mute)", marginBottom: 8 }}>Contacts on file ({contacts.length})</div>
          {contacts.length === 0
            ? <div className="banner warn" style={{ marginBottom: 16 }}>No contact record is on file. The system never fabricates phone numbers or email addresses.</div>
            : contacts.map((contact) => <ContactRecord key={contact.contact_id || `${contact.source}-${contact.mailing_address}-${contact.phone}`} contact={contact} />)}
          <div className="th" style={{ fontFamily: "var(--mono)", fontSize: 10, letterSpacing: "0.16em", textTransform: "uppercase", color: "var(--tx-mute)", margin: "22px 0 8px" }}>Track record ({deals.length})</div>
          {deals.length === 0 ? <Empty title="No deal history found." /> : <div className="tablewrap"><table className="deals"><thead><tr><th>Role</th><th>Date</th><th>Address</th><th className="num">Price</th></tr></thead><tbody>{deals.map((d, i) => { const role = d.role || (d.buyer_entity_id === entityId ? "buyer" : d.seller_entity_id === entityId ? "seller" : "deal"); return <tr key={d.deal_id || i} style={{ cursor: "default" }}><td><Pill kind={role === "buyer" ? "asset" : "src"}>{role}</Pill></td><td className="money">{shortDate(d.sale_date)}</td><td>{d.address || "-"}<div style={{ color: "var(--tx-mute)", fontSize: 11 }}>{d.borough || "-"} · {d.asset_type || "asset"}</div></td><td className="num">{money(d.sale_price, true)}</td></tr>; })}</tbody></table></div>}
        </>}
      </div>
    </div>
  );
}
