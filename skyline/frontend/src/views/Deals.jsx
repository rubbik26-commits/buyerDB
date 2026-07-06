import React, { useEffect, useState, useCallback } from "react";
import { api, money, num, shortDate } from "../api/client.js";
import { Pill, Loading, Empty, ErrorBanner, EntityDrawer } from "../components/ui.jsx";

const COLS = [
  { key: "sale_date", label: "Date", num: false },
  { key: "address", label: "Address", num: false },
  { key: "asset", label: "Asset", num: false, nosort: true },
  { key: "buyer", label: "Buyer", num: false, nosort: true },
  { key: "sale_price", label: "Price", num: true },
  { key: "units", label: "Units", num: true },
  { key: "ppsf", label: "PPSF", num: true },
];

const EMPTY = {
  q: "", borough: "", asset_type: "", price_min: "", price_max: "",
  date_min: "", date_max: "", units_min: "", units_max: "", sqft_min: "",
  ppsf_max: "", confidence_min: "", status: "", has_buyer: false,
};

export default function Deals({ meta }) {
  const [f, setF] = useState(EMPTY);
  const [applied, setApplied] = useState(EMPTY);
  const [sort, setSort] = useState("sale_date");
  const [order, setOrder] = useState("desc");
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const [open, setOpen] = useState(null);
  const [drawer, setDrawer] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    setErr(null);
    api.deals({ ...applied, has_buyer: applied.has_buyer ? "true" : "", sort, order, page, per_page: 25 })
      .then((d) => setData(d))
      .catch(setErr)
      .finally(() => setLoading(false));
  }, [applied, sort, order, page]);

  useEffect(() => { load(); }, [load]);

  const apply = () => { setApplied(f); setPage(1); };
  const reset = () => { setF(EMPTY); setApplied(EMPTY); setPage(1); };
  const clickSort = (key) => {
    if (COLS.find((c) => c.key === key)?.nosort) return;
    if (sort === key) setOrder(order === "desc" ? "asc" : "desc");
    else { setSort(key); setOrder("desc"); }
    setPage(1);
  };

  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value });
  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.per_page)) : 1;

  return (
    <div className="content">
      <div className="view-head">
        <div className="eyebrow">Transaction ledger</div>
        <h1>Closed deals</h1>
        <p>Every verified NYC commercial transaction. Filter fourteen ways, sort any column, expand a row for full provenance. Condos, co-ops, and 1–2 family are excluded by rule.</p>
      </div>

      <div className="filters">
        <div className="field" style={{ minWidth: 220 }}>
          <label>Search address / party</label>
          <input value={f.q} onChange={set("q")} placeholder="e.g. Atlantic Ave, Fannie Mae" onKeyDown={(e) => e.key === "Enter" && apply()} />
        </div>
        <div className="field">
          <label>Borough</label>
          <select value={f.borough} onChange={set("borough")}>
            <option value="">All</option>
            {meta.boroughs.map((b) => <option key={b}>{b}</option>)}
          </select>
        </div>
        <div className="field">
          <label>Asset type</label>
          <select value={f.asset_type} onChange={set("asset_type")}>
            <option value="">All</option>
            {meta.asset_types.map((a) => <option key={a}>{a}</option>)}
          </select>
        </div>
        <div className="field narrow"><label>Price min</label><input value={f.price_min} onChange={set("price_min")} placeholder="$" inputMode="numeric" /></div>
        <div className="field narrow"><label>Price max</label><input value={f.price_max} onChange={set("price_max")} placeholder="$" inputMode="numeric" /></div>
        <div className="field narrow"><label>Date from</label><input value={f.date_min} onChange={set("date_min")} placeholder="YYYY-MM-DD" /></div>
        <div className="field narrow"><label>Date to</label><input value={f.date_max} onChange={set("date_max")} placeholder="YYYY-MM-DD" /></div>
        <div className="field narrow"><label>Units min</label><input value={f.units_min} onChange={set("units_min")} inputMode="numeric" /></div>
        <div className="field narrow"><label>Units max</label><input value={f.units_max} onChange={set("units_max")} inputMode="numeric" /></div>
        <div className="field narrow"><label>SqFt min</label><input value={f.sqft_min} onChange={set("sqft_min")} inputMode="numeric" /></div>
        <div className="field narrow"><label>PPSF max</label><input value={f.ppsf_max} onChange={set("ppsf_max")} inputMode="numeric" /></div>
        <div className="field narrow"><label>Min conf.</label><input value={f.confidence_min} onChange={set("confidence_min")} inputMode="numeric" /></div>
        <div className="field">
          <label>Status</label>
          <select value={f.status} onChange={set("status")}>
            <option value="">Any</option>
            <option value="ok">Verified</option>
            <option value="needs_review">Needs review</option>
          </select>
        </div>
        <div className="field">
          <label>Has buyer</label>
          <div className="chip-row">
            <span className={`chip ${f.has_buyer ? "on" : ""}`} onClick={() => setF({ ...f, has_buyer: !f.has_buyer })}>
              {f.has_buyer ? "buyer named" : "any"}
            </span>
          </div>
        </div>
        <div className="spacer" />
        <button className="btn" onClick={apply}>Apply filters</button>
        <button className="btn ghost" onClick={reset}>Reset</button>
      </div>

      <ErrorBanner error={err} />

      {loading && !data ? <Loading label="Querying ledger…" /> : null}

      {data && (
        <>
          {data.pulse && data.total > 0 && (
            <div style={{ display: "flex", gap: 22, marginBottom: 12, fontFamily: "var(--mono)", fontSize: 12.5, color: "var(--tx-dim)" }}>
              <span><strong style={{ color: "var(--tx)" }}>{num(data.total)}</strong> matching</span>
              <span>volume <strong style={{ color: "var(--brass-deep)" }}>{money(data.pulse.vol, true)}</strong></span>
              <span>median <strong style={{ color: "var(--tx)" }}>{money(data.pulse.median, true)}</strong></span>
            </div>
          )}

          {data.total === 0 ? (
            <Empty title="No deals match these filters." hint="Loosen a constraint or reset." />
          ) : (
            <div className="tablewrap">
              <table className="deals">
                <thead>
                  <tr>
                    {COLS.map((c) => (
                      <th key={c.key} className={c.num ? "num" : ""} onClick={() => clickSort(c.key)}>
                        {c.label}
                        {sort === c.key && <span className="sort">{order === "desc" ? "▾" : "▴"}</span>}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.deals.map((d) => (
                    <React.Fragment key={d.deal_id}>
                      <tr className={open === d.deal_id ? "open" : ""} onClick={() => setOpen(open === d.deal_id ? null : d.deal_id)}>
                        <td className="money">{shortDate(d.sale_date)}</td>
                        <td>
                          <span className="addr">{d.address}</span>
                          <div style={{ color: "var(--tx-mute)", fontSize: 11 }}>{d.borough || d.market || "—"}</div>
                        </td>
                        <td><Pill kind="asset">{d.asset_type || "—"}</Pill></td>
                        <td className="party">
                          {d.buyer || <span style={{ color: "var(--tx-mute)" }}>—</span>}
                          {d.parse_status === "needs_review" && <div style={{ marginTop: 3 }}><Pill kind="review">review</Pill></div>}
                        </td>
                        <td className="num">{money(d.sale_price, true)}</td>
                        <td className="num">{num(d.units)}</td>
                        <td className="num">{d.ppsf ? "$" + num(d.ppsf) : "—"}</td>
                      </tr>
                      {open === d.deal_id && (
                        <tr className="detail-row">
                          <td colSpan={COLS.length}>
                            <div className="detail">
                              <KV k="Seller" v={d.seller || "—"} />
                              <KV k="Full price" v={money(d.sale_price)} mono />
                              <KV k="PPU" v={d.ppu ? money(d.ppu) : "—"} mono />
                              <KV k="PPSF" v={d.ppsf ? "$" + num(d.ppsf) : "—"} mono />
                              <KV k="Sq ft" v={num(d.sqft)} mono />
                              <KV k="Confidence" v={d.confidence != null ? d.confidence + "/100" : "—"} mono />
                              <KV k="Source" v={<Pill kind="src">{d.source_system}</Pill>} />
                              <div className="kv">
                                <div className="k">Actions</div>
                                <div className="v" style={{ display: "flex", gap: 8, marginTop: 4 }}>
                                  {d.source_url && <a className="btn ghost sm" href={d.source_url} target="_blank" rel="noreferrer">Open source</a>}
                                </div>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="pager">
            <div className="info">Page {data.page} of {num(totalPages)} · {num(data.total)} deals</div>
            <div className="btns">
              <button className="btn ghost sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>← Prev</button>
              <button className="btn ghost sm" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>Next →</button>
            </div>
          </div>
        </>
      )}

      <EntityDrawer entityId={drawer} onClose={() => setDrawer(null)} />
    </div>
  );
}

function KV({ k, v, mono }) {
  return (
    <div className="kv">
      <div className="k">{k}</div>
      <div className={`v ${mono ? "mono" : ""}`}>{v}</div>
    </div>
  );
}
