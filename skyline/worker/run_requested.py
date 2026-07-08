"""Claim and execute scraper requests created by the frontend Scrapers tab.

The Netlify Scrapers tab writes request rows into sbi_source_runs. Because
sbi_source_runs only allows operational statuses, a queued frontend request is
stored as status='running' with stats.requested_status='requested'. This worker
claims those rows and dispatches the live worker modules.
"""
import argparse
import json
import os
import sys
import traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from worker import sbi_store as store

SUPPORTED = {"traded_refresh", "acris_refresh", "property_owner_refresh", "full_refresh"}
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
        cur.execute(f"UPDATE {RUNS_TABLE} SET stats=%s WHERE run_id=%s", (json.dumps(stats), run_id))
        return {"run_id": run_id, "job": job, "stats": stats}


def finish(conn, run_id, status, stats=None, error=None):
    store.finish_run(conn, run_id, status, stats or {}, error=error)
    conn.commit()


def run_traded(limit=None):
    from worker import run_incremental
    return run_incremental.run(limit=limit)


def run_acris(limit=None):
    from worker import phase2_stages
    return phase2_stages.run(limit=limit)


def execute(job, options=None):
    options = options or {}
    limit = options.get("limit") or options.get("max_records")
    if isinstance(limit, str) and limit.isdigit():
        limit = int(limit)
    if job == "traded_refresh":
        return {"traded_refresh": run_traded(limit=limit)}
    if job in ("acris_refresh", "property_owner_refresh"):
        return {job: run_acris(limit=limit)}
    if job == "full_refresh":
        return {"traded_refresh": run_traded(limit=limit), "acris_refresh": run_acris(limit=limit)}
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
            return {"claimed": True, "run_id": str(run_id), "job": job, "status": "success", "result": result}
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
