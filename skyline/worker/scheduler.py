"""scheduler.py — production Python cron/worker entrypoints.

Netlify is the control plane. This file is the Python runtime plane:

  * queue daemon: claims manual Scrapers-tab requests from sbi_source_runs
  * daily cron: traded incremental + fresh ACRIS + Rolling Sales
  * weekly cron: delayed ACRIS party/owner enrichment
  * full cron: daily + weekly + optional Crexi

It deliberately does not use GitHub Actions. Deploy it as a long-running worker
and cron jobs on a Python host such as Render, Railway, Fly.io, or a VPS.
"""
from __future__ import annotations

import argparse
import json
import os
import signal
import sys
import time
import traceback
from datetime import datetime, timezone
from typing import Any, Dict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from worker import run_requested

_STOP = False


def _handle_stop(_signum, _frame):
    global _STOP
    _STOP = True


signal.signal(signal.SIGTERM, _handle_stop)
signal.signal(signal.SIGINT, _handle_stop)


def _print(payload: Dict[str, Any]) -> None:
    print(json.dumps({"ts": datetime.now(timezone.utc).isoformat(), **payload}, default=str), flush=True)


def run_queue_once(job: str | None = None, max_claims: int = 1) -> Dict[str, Any]:
    results = []
    for _ in range(max(1, max_claims)):
        result = run_requested.run_once(only_job=job)
        results.append(result)
        if not result.get("claimed"):
            break
    return {"mode": "queue_once", "claimed": sum(1 for r in results if r.get("claimed")), "results": results}


def run_queue_daemon(job: str | None = None, poll_seconds: int | None = None, max_claims_per_tick: int | None = None) -> Dict[str, Any]:
    poll_seconds = poll_seconds or int(os.environ.get("WORKER_POLL_SECONDS", "30"))
    max_claims_per_tick = max_claims_per_tick or int(os.environ.get("WORKER_MAX_CLAIMS_PER_TICK", "1"))
    _print({"mode": "queue_daemon", "status": "started", "poll_seconds": poll_seconds, "max_claims_per_tick": max_claims_per_tick})
    ticks = 0
    claimed_total = 0
    while not _STOP:
        ticks += 1
        try:
            result = run_queue_once(job=job, max_claims=max_claims_per_tick)
            claimed_total += result["claimed"]
            if result["claimed"]:
                _print({"mode": "queue_daemon", "tick": ticks, **result})
        except Exception:
            _print({"mode": "queue_daemon", "status": "error", "error": traceback.format_exc()[:2000]})
        slept = 0
        while slept < poll_seconds and not _STOP:
            time.sleep(1)
            slept += 1
    final = {"mode": "queue_daemon", "status": "stopped", "ticks": ticks, "claimed_total": claimed_total}
    _print(final)
    return final


def run_daily(limit: int | None = None, rolling_batch: int | None = None) -> Dict[str, Any]:
    from worker import run_incremental, phase3_fresh, rolling_sales

    rolling_batch = rolling_batch or int(os.environ.get("ROLLING_BATCH", "400"))
    result = {
        "mode": "daily",
        "traded_incremental": run_incremental.run(limit=limit),
        "acris_fresh": phase3_fresh.run(limit=limit),
        "rolling_sales": rolling_sales.run(batch=rolling_batch),
    }
    _print(result)
    return result


def run_weekly(limit: int | None = None) -> Dict[str, Any]:
    from worker import phase2_stages

    result = {"mode": "weekly", "phase2_owner_party_enrichment": phase2_stages.run(limit=limit)}
    _print(result)
    return result


def run_full(limit: int | None = None, rolling_batch: int | None = None) -> Dict[str, Any]:
    from worker import crexi_refresh

    result = {"mode": "full", "daily": run_daily(limit=limit, rolling_batch=rolling_batch), "weekly": run_weekly(limit=limit)}
    try:
        result["crexi_refresh"] = crexi_refresh.run(limit=limit)
    except Exception:
        result["crexi_refresh"] = {"status": "failed", "error": traceback.format_exc()[:2000]}
    _print(result)
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description="Skyline production Python scraper scheduler.")
    parser.add_argument("--mode", choices=["queue-once", "queue-daemon", "daily", "weekly", "full"], default=os.environ.get("WORKER_MODE", "queue-daemon"))
    parser.add_argument("--job", choices=sorted(run_requested.SUPPORTED), help="Restrict queued manual claims to one job type.")
    parser.add_argument("--limit", type=int, help="Optional record/url limit for bounded runs.")
    parser.add_argument("--rolling-batch", type=int, help="Rolling Sales batch size.")
    parser.add_argument("--max-claims", type=int, default=int(os.environ.get("WORKER_MAX_CLAIMS_PER_TICK", "1")))
    parser.add_argument("--poll-seconds", type=int, default=int(os.environ.get("WORKER_POLL_SECONDS", "30")))
    args = parser.parse_args()

    if args.mode == "queue-once":
        _print(run_queue_once(job=args.job, max_claims=args.max_claims))
    elif args.mode == "queue-daemon":
        run_queue_daemon(job=args.job, poll_seconds=args.poll_seconds, max_claims_per_tick=args.max_claims)
    elif args.mode == "daily":
        run_daily(limit=args.limit, rolling_batch=args.rolling_batch)
    elif args.mode == "weekly":
        run_weekly(limit=args.limit)
    elif args.mode == "full":
        run_full(limit=args.limit, rolling_batch=args.rolling_batch)


if __name__ == "__main__":
    main()
