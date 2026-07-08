"""run_requested.py — claim scraper requests created by the UI.

The Scrapers tab writes durable rows to scrape_runs with status='requested'. This
worker claims those rows and dispatches the existing proven worker modules. It is
safe to run from cron/GitHub Actions/Render because the claim uses FOR UPDATE
SKIP LOCKED and never runs the same requested row twice concurrently.
"""
import argparse
import json
import os
import sys
import traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from worker import store


SUPPORTED = {"traded_refresh", "acris_refresh", "property_owner_refresh", "full_refresh"}


def _claim(conn, only_job=None):
    where = "status='requested'"
    params = []
    if only_job:
        where += " AND job=%s"
        params.append(only_job)
    with conn.cursor() as cur:
        cur.execute(f"""
            SELECT run_id, job, stats
            FROM scrape_runs
            WHERE {where}
            ORDER BY started_at ASC
            FOR UPDATE SKIP LOCKED
            LIMIT 1
        """, params)
        row = cur.fetchone()
        if not row:
            return None
        run_id, job, stats = row
        cur.execute("UPDATE scrape_runs SET status='running' WHERE run_id=%s", (run_id,))
        return {"run_id": run_id, "job": job, "stats": stats or {}}


def _finish(conn, run_id, status, stats=None, error=None):
    store.finish_run(conn, run_id, status, stats or {}, error=error)
    conn.commit()


def _run_traded(limit=None):
    from worker import run_incremental
    return run_incremental.run(limit=limit)


def _run_acris(limit=None):
    from worker import phase2_stages
    return phase2_stages.run(limit=limit)


def execute(job, options=None):
    options = options or {}
    limit = options.get("limit") or options.get("max_records")
    if isinstance(limit, str) and limit.isdigit():
        limit = int(limit)
    if job == "traded_refresh":
        return {"traded_refresh": _run_traded(limit=limit)}
    if job in ("acris_refresh", "property_owner_refresh"):
        return {job: _run_acris(limit=limit)}
    if job == "full_refresh":
        return {
            "traded_refresh": _run_traded(limit=limit),
            "acris_refresh": _run_acris(limit=limit),
        }
    return {"error": f"Unsupported requested job: {job}"}


def run_once(only_job=None):
    conn = store.connect()
    try:
        claimed = _claim(conn, only_job=only_job)
        conn.commit()
        if not claimed:
            return {"claimed": False}
        run_id = claimed["run_id"]
        job = claimed["job"]
        request_stats = claimed.get("stats") or {}
        options = {}
        if isinstance(request_stats, dict):
            options = request_stats.get("options") or {}
        if job not in SUPPORTED:
            _finish(conn, run_id, "failed", {"requested_job": job}, error="Job is not supported by run_requested.py")
            return {"claimed": True, "run_id": str(run_id), "job": job, "status": "failed"}
        try:
            result = execute(job, options=options)
            _finish(conn, run_id, "success", {"requested_job": job, "result": result})
            return {"claimed": True, "run_id": str(run_id), "job": job, "status": "success", "result": result}
        except Exception:
            err = traceback.format_exc()[:2000]
            _finish(conn, run_id, "failed", {"requested_job": job}, error=err)
            raise
    finally:
        conn.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Run one requested scraper job from scrape_runs.")
    parser.add_argument("--job", choices=sorted(SUPPORTED), help="Only claim this job type.")
    args = parser.parse_args()
    print(json.dumps(run_once(only_job=args.job), default=str))
