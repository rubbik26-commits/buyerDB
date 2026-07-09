"""Claim and execute scraper requests created by the frontend Scrapers tab.

The Netlify/Supabase Scrapers tab writes request rows into sbi_source_runs using
api_request_scrape(). This worker claims those durable requests and dispatches
the Python scraper modules. Netlify remains the control panel; Python remains the
runtime for scraping, normalization, ledgers, and gated merges.
"""
import argparse
import json
import os
import sys
import traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from worker import sbi_store as store

SUPPORTED = {"traded_refresh", "acris_refresh", "crexi_refresh", "property_owner_refresh", "full_refresh"}
RUNS_TABLE = "sbi_source_runs"


def claim(conn, only_job=None):
    where = "status='running' AND coalesce(stats->>'requested_status','')='requested'"
    params = []
    if only_job:
        where += " AND job=%s"
        params.append(only_job)
    with conn.cursor() as cur:
        cur.execute(f"""
            SELECT run_id, job, stats
            FROM {RUNS_TABLE}
            WHERE {where}
            ORDER BY started_at ASC NULLS LAST
            FOR UPDATE SKIP LOCKED
            LIMIT 1
        """, params)
        row = cur.fetchone()
        if not row:
            return None
        run_id, job, stats = row
        stats = stats or {}
        if isinstance(stats, str):
            try:
                stats = json.loads(stats)
            except Exception:
                stats = {}
        stats["requested_status"] = "claimed"
        cur.execute(
            f"UPDATE {RUNS_TABLE} SET stats=%s, source='python-worker' WHERE run_id=%s",
            (json.dumps(stats), run_id),
        )
        return {"run_id": run_id, "job": job, "stats": stats}


def finish(conn, run_id, status, stats=None, error=None):
    store.finish_run(conn, run_id, status, stats or {}, error=error)
    conn.commit()


def _limit(options):
    value = (options or {}).get("limit") or (options or {}).get("max_records")
    if isinstance(value, str) and value.isdigit():
        return int(value)
    return value if isinstance(value, int) else None


def run_traded(limit=None):
    from worker import run_incremental
    return run_incremental.run(limit=limit)


def run_acris_fresh(limit=None):
    from worker import phase3_fresh
    return phase3_fresh.run(limit=limit)


def run_owner_enrichment(limit=None):
    from worker import phase2_stages
    return phase2_stages.run(limit=limit)


def run_rolling(batch=None):
    from worker import rolling_sales
    return rolling_sales.run(batch=batch or int(os.environ.get("ROLLING_BATCH", "400")))


def run_crexi(limit=None, options=None):
    from worker import crexi_refresh
    options = options or {}
    return crexi_refresh.run(dataset_id=options.get("datasetId") or options.get("dataset_id"), limit=limit)


def execute(job, options=None):
    options = options or {}
    limit = _limit(options)
    if job == "traded_refresh":
        return {"traded_refresh": run_traded(limit=limit)}
    if job == "acris_refresh":
        return {"acris_refresh": run_acris_fresh(limit=limit)}
    if job == "property_owner_refresh":
        return {"property_owner_refresh": run_owner_enrichment(limit=limit)}
    if job == "crexi_refresh":
        return {"crexi_refresh": run_crexi(limit=limit, options=options)}
    if job == "full_refresh":
        result = {
            "traded_refresh": run_traded(limit=limit),
            "acris_refresh": run_acris_fresh(limit=limit),
            "rolling_sales": run_rolling(batch=options.get("rolling_batch")),
            "property_owner_refresh": run_owner_enrichment(limit=limit),
        }
        # Crexi is optional because it requires APIFY_TOKEN/APIFY_CREXI_ACTOR. If
        # configured, include it in full refresh; otherwise record a skipped status.
        if os.environ.get("APIFY_TOKEN") or os.environ.get("APIFY_API_TOKEN"):
            result["crexi_refresh"] = run_crexi(limit=limit, options=options)
        else:
            result["crexi_refresh"] = {"status": "skipped_not_configured", "reason": "APIFY_TOKEN/APIFY_CREXI_ACTOR not set"}
        return result
    return {"error": f"Unsupported requested job: {job}"}


def run_once(only_job=None):
    conn = store.connect()
    try:
        claimed = claim(conn, only_job=only_job)
        conn.commit()
        if not claimed:
            return {"claimed": False}
        run_id = claimed["run_id"]
        job = claimed["job"]
        request_stats = claimed.get("stats") or {}
        options = request_stats.get("options") if isinstance(request_stats, dict) else {}
        options = options or {}
        if job not in SUPPORTED:
            finish(conn, run_id, "failed", {"requested_job": job}, error="Unsupported requested job")
            return {"claimed": True, "run_id": str(run_id), "job": job, "status": "failed"}
        try:
            result = execute(job, options=options)
            finish(conn, run_id, "success", {"requested_job": job, "result": result})
            return {"claimed": True, "run_id": str(run_id), "job": job, "status": "completed", "result": result}
        except Exception:
            err = traceback.format_exc()[:2000]
            finish(conn, run_id, "failed", {"requested_job": job}, error=err)
            raise
    finally:
        conn.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Run one requested scraper job from sbi_source_runs.")
    parser.add_argument("--job", choices=sorted(SUPPORTED), help="Only claim this job type.")
    args = parser.parse_args()
    print(json.dumps(run_once(only_job=args.job), default=str))
