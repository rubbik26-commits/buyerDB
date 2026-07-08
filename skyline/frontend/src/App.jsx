import React, { useEffect, useState } from "react";
import { api, IS_RPC_MODE, money, num } from "./api/client.js";
import { Loading } from "./components/ui.jsx";
import Workbench from "./views/Workbench.jsx";
import Deals from "./views/Deals.jsx";
import Properties from "./views/Properties.jsx";
import Buyers from "./views/Buyers.jsx";
import Leaderboards from "./views/Leaderboards.jsx";
import MapView from "./views/Map.jsx";
import Agent from "./views/Agent.jsx";
import Uploads from "./views/Uploads.jsx";
import Tasks from "./views/Tasks.jsx";
import Scrapers from "./views/Scrapers.jsx";
import Review from "./views/Review.jsx";

const TABS = [
  { id: "workbench", label: "Workbench", glyph: "◆", C: Workbench },
  { id: "deals", label: "Deals", glyph: "▤", C: Deals },
  { id: "properties", label: "Properties", glyph: "⌂", C: Properties },
  { id: "buyers", label: "Buyers", glyph: "◈", C: Buyers },
  { id: "boards", label: "Leaderboards", glyph: "▚", C: Leaderboards },
  { id: "map", label: "Map", glyph: "◎", C: MapView },
  { id: "agent", label: "Deal Desk", glyph: "✦", C: Agent },
  { id: "uploads", label: "Contacts", glyph: "↥", C: Uploads },
  { id: "tasks", label: "Tasks", glyph: "☑", C: Tasks },
  { id: "scrapers", label: "Scrapers", glyph: "↻", C: Scrapers },
  { id: "review", label: "Review", glyph: "◍", C: Review },
];

export default function App() {
  const [tab, setTab] = useState("workbench");
  const [meta, setMeta] = useState(null);
  const [err, setErr] = useState(null);

  const loadMeta = () => { setErr(null); return api.meta().then(setMeta).catch(setErr); };
  useEffect(() => { loadMeta(); }, []);

  const Active = TABS.find((t) => t.id === tab).C;
  const s = meta?.stats;

  return (
    <div className="app">
      <aside className="rail">
        <div className="brand"><div><div className="mark">Sky<em>line</em></div><div className="sub">Buyer Intelligence OS</div></div></div>
        <nav className="nav">
          {TABS.map((t) => (
            <button key={t.id} className={t.id === tab ? "active" : ""} onClick={() => setTab(t.id)}>
              <span className="glyph">{t.glyph}</span>{t.label}{t.id === "review" && s?.open_reviews ? <span className="badge">{s.open_reviews}</span> : null}
            </button>
          ))}
        </nav>
        <div className="foot">
          <div className="k">DATASET</div><div className="v">{s ? num(s.deals) + " deals" : "…"}</div>
          <div className="k" style={{ marginTop: 8 }}>COVERAGE</div><div className="v">{s && s.earliest ? `${String(s.earliest).slice(0,4)}–${String(s.latest).slice(0,4)}` : "—"}</div>
        </div>
      </aside>
      <main className="main">
        <div className="pulse">
          <Cell lab="Closed deals" val={s ? num(s.deals) : "…"} />
          <Cell lab="Total volume" val={s ? money(s.total_volume, true) : "…"} accent />
          <Cell lab="Unique buyers" val={s ? num(s.unique_buyers) : "…"} />
          <Cell lab="With price" val={s ? num(s.priced) : "…"} />
          <Cell lab="Contacts" val={s ? num(s.contacts) : "…"} />
          <Cell lab="Open review" val={s ? num(s.open_reviews) : "…"} />
        </div>
        {err && <div className="content"><div className="banner err">Can’t reach the API at <code>{api.base}</code>. {IS_RPC_MODE ? "The Supabase project may be paused, unreachable, or missing VITE_SUPABASE_ANON_KEY." : <>Start the backend (<code>uvicorn backend.app.main:app</code>) or set <code>VITE_API_URL</code>.</>} {" — "}{String(err.message || err)}</div></div>}
        {!meta && !err && <Loading label="Loading market…" />}
        {meta && <Active meta={meta} refreshMeta={loadMeta} />}
      </main>
    </div>
  );
}

function Cell({ lab, val, accent }) {
  return <div className="cell"><div className="lab">{lab}</div><div className="val">{accent ? <em>{val}</em> : val}</div></div>;
}
