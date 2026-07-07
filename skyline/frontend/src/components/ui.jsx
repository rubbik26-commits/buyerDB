import React, { useEffect, useState } from "react";
import { api, money, shortDate } from "../api/client.js";

export function Pill({ kind, children }) {
  return <span className={`pill ${kind}`}>{children}</span>;
}

export function Loading({ label = "Loading…" }) {
  return (
    <div className="loading">
      <span className="spinner" /> {label}
    </div>
  );
}

export function Empty({ title, hint }) {
  return (
    <div className="empty">
      <div className="big">{title}</div>
      {hint && <div>{hint}</div>}
    </div>
  );
}

export function ErrorBanner({ error }) {
  if (!error) return null;
  return <div className="banner err">{String(error.message || error)}</div>;
}

/* Slide-in entity dossier: deal history + contacts (contacts only from DB rows). */
export function EntityDrawer({ entityId, onClose }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    if (!entityId) return;
    setData(null);
    setErr(null);
    // stale-guard: closing A and quickly opening B must not let A's slower
    // response render A's contacts under B's header
    let stale = false;
    api.entity(entityId)
      .then((d) => { if (!stale) setData(d); })
      .catch((e) => { if (!stale) setErr(e); });
    return () => { stale = true; };
  }, [entityId]);
  useEffect(() => {
    if (!entityId) return;
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [entityId, onClose]);
  if (!entityId) return null;
  return (
    <div
      style={{ position: "fixed", inset: 0, background: "rgba(18,22,31,0.45)", zIndex: 50, display: "flex", justifyContent: "flex-end" }}
      onClick={onClose}
    >
      <div
        style={{ width: "min(560px, 94vw)", background: "var(--paper)", height: "100%", overflowY: "auto", boxShadow: "var(--shadow-lg)", padding: "24px 26px" }}
        onClick={(e) => e.stopPropagation()}
      >
        <button className="btn ghost sm" onClick={onClose} style={{ float: "right" }}>Close</button>
        <ErrorBanner error={err} />
        {!data && !err && <Loading />}
        {data && !data.entity && <Empty title="Entity not found." />}
        {data && data.entity && (
          <>
            <div className="view-head" style={{ marginBottom: 14 }}>
              <div className="eyebrow">
                {data.entity.entity_type}
                {data.entity.is_spv_suspect ? " · single-purpose LLC" : ""}
              </div>
              <h1 style={{ fontSize: 24 }}>{data.entity.display_name}</h1>
            </div>

            <div className="th" style={{ fontFamily: "var(--mono)", fontSize: 10, letterSpacing: "0.16em", textTransform: "uppercase", color: "var(--tx-mute)", marginBottom: 8 }}>
              Contacts on file ({data.contacts.length})
            </div>
            {data.contacts.length === 0 ? (
              <div className="banner warn" style={{ marginBottom: 16 }}>
                No phone or email on file. Public records (ACRIS/PLUTO) cap at mailing addresses —
                phone and email exist only where a source published them or a broker uploaded them.
              </div>
            ) : (
              data.contacts.map((c, i) => (
                <div className="cite" key={i} style={{ marginBottom: 6 }}>
                  <span className="nm">{c.person_name || "—"}</span>
                  <span className="mono">
                    {c.phone || "no phone"} · {c.email || "no email"} · {c.source}
                  </span>
                </div>
              ))
            )}

            <div className="th" style={{ fontFamily: "var(--mono)", fontSize: 10, letterSpacing: "0.16em", textTransform: "uppercase", color: "var(--tx-mute)", margin: "22px 0 8px" }}>
              Track record ({data.deals.length})
            </div>
            <div className="tablewrap">
              <table className="deals">
                <thead>
                  <tr>
                    <th>Role</th><th>Date</th><th>Address</th><th className="num">Price</th>
                  </tr>
                </thead>
                <tbody>
                  {data.deals.map((d, i) => (
                    <tr key={i} style={{ cursor: "default" }}>
                      <td><Pill kind={d.role === "buyer" ? "asset" : "src"}>{d.role}</Pill></td>
                      <td className="money">{shortDate(d.sale_date)}</td>
                      <td>{d.address}<div style={{ color: "var(--tx-mute)", fontSize: 11 }}>{d.borough} · {d.asset_type}</div></td>
                      <td className="num">{money(d.sale_price, true)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
