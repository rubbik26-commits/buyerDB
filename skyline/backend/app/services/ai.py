"""Shared AI plumbing: one Router wired to an ai_logs writer.
Importing get_router() gives a process-wide router whose every attempt (success or
failover) is written to ai_logs — the blueprint's requirement that free-tier drift
be observable."""
from ..db import db
from .provider_router import Router, default_adapters


def _log_ai(**kw):
    try:
        with db() as conn, conn.cursor() as cur:
            cur.execute(
                """INSERT INTO ai_logs (user_id, provider, model, purpose, latency_ms,
                                        input_tokens, output_tokens, fallback_from, status)
                   VALUES (%(user_id)s,%(provider)s,%(model)s,%(purpose)s,%(latency_ms)s,
                           %(input_tokens)s,%(output_tokens)s,%(fallback_from)s,%(status)s)""",
                {"user_id": kw.get("user_id"), "provider": kw.get("provider"),
                 "model": kw.get("model"), "purpose": kw.get("purpose"),
                 "latency_ms": kw.get("latency_ms"), "input_tokens": kw.get("input_tokens"),
                 "output_tokens": kw.get("output_tokens"), "fallback_from": kw.get("fallback_from"),
                 "status": kw.get("status")})
    except Exception:
        # logging must never break the request path; the router already raises on real failures
        pass


_router = None

def get_router():
    global _router
    if _router is None:
        _router = Router(adapters=default_adapters(), log_fn=_log_ai)
    return _router
