"""main.py — Skyline Deal Intelligence API.
Run: uvicorn backend.app.main:app --reload
"""
import os
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from .db import db, rows
from .routes import deals, agent, uploads, review, workbench, admin, outreach, saved_views, property_map

app = FastAPI(title="Skyline Deal Intelligence API", version="1.1")

origins = [o.strip() for o in os.environ.get("FRONTEND_URL", "http://localhost:5173").split(",")
           if o.strip() and o.strip() != "*"]
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins + ["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True, allow_methods=["*"], allow_headers=["*"],
)

app.include_router(deals.router)
app.include_router(agent.router)
app.include_router(uploads.router)
app.include_router(review.router)
app.include_router(workbench.router)
app.include_router(admin.router)
app.include_router(outreach.router)
app.include_router(saved_views.router)
app.include_router(property_map.router)


@app.get("/api/health")
def health():
    with db() as conn, conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM deals")
        n = cur.fetchone()[0]
    return {"status": "ok", "deals": n}


@app.get("/api/meta")
def meta():
    """Filter options + headline stats for the frontend to populate dropdowns."""
    with db() as conn, conn.cursor() as cur:
        cur.execute("SELECT DISTINCT asset_type FROM deals WHERE asset_type IS NOT NULL ORDER BY 1")
        asset_types = [r[0] for r in cur.fetchall()]
        cur.execute("SELECT DISTINCT borough FROM properties WHERE borough IS NOT NULL ORDER BY 1")
        boroughs = [r[0] for r in cur.fetchall()]
        cur.execute("""SELECT count(*) AS deals,
                          count(*) FILTER (WHERE sale_price IS NOT NULL) AS priced,
                          coalesce(sum(sale_price),0) AS total_volume,
                          min(sale_date) AS earliest, max(sale_date) AS latest
                       FROM deals""")
        stats = rows(cur)[0]
        cur.execute("SELECT count(DISTINCT entity_id) FROM deal_parties WHERE role='buyer'")
        stats["unique_buyers"] = cur.fetchone()[0]
        cur.execute("SELECT count(*) FROM review_queue WHERE status='open'")
        stats["open_reviews"] = cur.fetchone()[0]
        cur.execute("SELECT count(*) FROM contacts")
        stats["contacts"] = cur.fetchone()[0]
    return {"asset_types": asset_types, "boroughs": boroughs, "stats": stats}
