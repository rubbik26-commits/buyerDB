import React, { useEffect, useMemo, useState } from "react";
import { money, shortDate } from "../api/client.js";
import { Empty, ErrorBanner, Loading, Pill } from "../components/ui.jsx";

const BASE = import.meta.env.VITE_API_URL || "http://localhost:8000";
const ANON = import.meta.env.VITE_SUPABASE_ANON_KEY || "";
const IS_RPC_MODE = BASE.includes(".supabase.co");

async function loadMap() {
  if (!IS_RPC_MODE) {
    const r = await fetch(`${BASE}/api/property-map`);
    if (!r.ok) throw new Error(`/api/property-map → HTTP ${r.status}`);
    return r.json();
  }
  if (!ANON) throw new Error("VITE_SUPABASE_ANON_KEY is required for the map feed.");
  const supa = new URL(BASE).origin;
  const r = await fetch(`${supa}/rest/v1/rpc/api_property_map`, {
    method: "POST",
    headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, "Content-Type": "application/json" },
    body: JSON.stringify({ lim: 1000 }),
  });
  if (!r.ok) throw new Error(`api_property_map → HTTP ${r.status} — ${(await r.text()).slice(0, 240)}`);
  return r.json();
}

export default function MapView() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [active, setActive] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = () => {
    setLoading(true);
    setErr(null);
    loadMap().then(setData).catch(setErr).finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

  const points = data?.points || [];
  const bounds = useMemo(() => {
    const valid = points.filter((p) => Number.isFinite(Number(p.latitude)) && Number.isFinite(Number(p.longitude)));
    if (!valid.length) return null;
    return {
      minLat: Math.min(...valid.map((p) => Number(p.latitude))),
      maxLat: Math.max(...valid.map((p) => Number(p.latitude))),
      minLng: Math.min(...valid.map((p) => Number(p.longitude))),
      maxLng: Math.max(...valid.map((p) => Number(p.longitude))),
    };
  }, [points]);

  const place = (p) => {
    if (!bounds) return { left: "50%", top: "50%" };
    const lngSpan = Math.max(bounds.maxLng - bounds.minLng, 0.0001);
    const latSpan = Math.max(bounds.maxLat - bounds.minLat, 0.0001);
    const left = ((Number(p.longitude) - bounds.minLng) / lngSpan) * 88 + 6;
    const top = (1 - (Number(p.latitude) - bounds.minLat) / latSpan) * 82 + 8;
    return { left: `${left}%`, top: `${top}%` };
  };

  return (
    <div className="content">
      <div className="view-head">
        <div className="eyebrow">Geography</div>
        <h1>Property map</h1>
        <p>Plots properties that have latitude and longitude in the live database. The map does not fake coordinates or use mock points.</p>
      </div>

      <ErrorBanner error={err} />
      {loading && !data ? <Loading label="Loading map feed…" /> : null}

      {data && points.length === 0 ? (
        <Empty title="No geocoded properties yet." hint="Load or enrich property latitude/longitude to populate the map." />
      ) : null}

      {points.length > 0 && (
        <div className="workgrid two">
          <section className="panel" style={{ minHeight: 520, position: "relative", overflow: "hidden" }}>
            <div style={{ position: "absolute", inset: 18, border: "1px solid var(--hair)", background: "linear-gradient(135deg, #f7f3ea, #e8dfcb)", borderRadius: "var(--r-lg)" }}>
              <div style={{ position: "absolute", inset: 0, backgroundImage: "linear-gradient(var(--hair) 1px, transparent 1px), linear-gradient(90deg, var(--hair) 1px, transparent 1px)", backgroundSize: "44px 44px", opacity: 0.45 }} />
              {points.map((p) => (
                <button
                  key={p.property_id}
                  onClick={() => setActive(p)}
                  title={p.address}
                  style={{
                    position: "absolute", ...place(p), transform: "translate(-50%, -50%)",
                    width: 12, height: 12, borderRadius: 20, border: "2px solid var(--paper)",
                    background: "var(--brass)", boxShadow: "0 2px 10px rgba(0,0,0,0.22)", cursor: "pointer",
                  }}
                />
              ))}
            </div>
          </section>

          <section className="panel">
            <div className="panelhead"><h2>{active ? active.address : "Select a property"}</h2></div>
            <div className="panelbody">
              {!active ? <Empty title="Click a map point." /> : (
                <>
                  <div className="workitem static"><strong>{active.address}</strong><span>{active.borough || "—"} · {active.market || "—"} · BBL {active.bbl || "—"}</span></div>
                  <div className="workitem static"><strong>{active.buyer || "Owner unknown"}</strong><span>latest buyer / owner · seller {active.seller || "—"}</span></div>
                  <div className="workitem static"><strong>{money(active.sale_price, true)}</strong><span>{active.asset_type || "asset"} · sold {shortDate(active.sale_date)}</span></div>
                  <Pill kind="src">{Number(active.latitude).toFixed(5)}, {Number(active.longitude).toFixed(5)}</Pill>
                </>
              )}
            </div>
          </section>
        </div>
      )}

      <div style={{ marginTop: 16 }}><button className="btn ghost" onClick={load}>Refresh map</button></div>
    </div>
  );
}
