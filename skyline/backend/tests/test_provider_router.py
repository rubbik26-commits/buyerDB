"""Provider-router failover tests (Acceptance C), using fake in-process adapters so
no real API keys are needed. Run: pytest backend/tests/test_provider_router.py -v"""
import os, sys
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
from backend.app.services.provider_router import Router, Adapter, ProviderError, SENSITIVE_DENY


class FakeAdapter(Adapter):
    """A configured adapter whose behavior is scripted."""
    def __init__(self, name, behavior, **kw):
        super().__init__(name, "http://fake", f"{name}-model", f"{name.upper()}_KEY_FAKE",
                         daily_budget=kw.get("daily_budget", 1000))
        self.behavior = behavior          # 'ok' | '429' | '500' | 'network' | 'exhausted' | 'boom'
        self.calls = 0

    @property
    def configured(self):                 # always "configured" for the test
        return self.behavior != "unconfigured"

    def complete(self, messages, json_mode=False, max_tokens=1200, timeout=20.0):
        self.calls += 1
        if self.behavior == "exhausted":
            raise ProviderError(self.name, "daily_budget_exhausted")
        if self.behavior == "429":
            raise ProviderError(self.name, "rate_limited", "HTTP 429")
        if self.behavior == "500":
            raise ProviderError(self.name, "server_error", "HTTP 500")
        if self.behavior == "network":
            raise ProviderError(self.name, "network", "conn reset")
        if self.behavior == "boom":       # a raw, non-ProviderError adapter bug
            raise KeyError("choices")
        return {"text": f"answer from {self.name}", "latency_ms": 5,
                "input_tokens": 10, "output_tokens": 5}


def _router(*specs, log=None):
    adapters = {name: FakeAdapter(name, beh) for name, beh in specs}
    return Router(adapters=adapters, log_fn=log), adapters


def test_primary_ok_no_fallback(monkeypatch):
    monkeypatch.setenv("AI_PROVIDER_ORDER", "groq,gemini")
    r, ad = _router(("groq", "ok"), ("gemini", "ok"))
    out = r.complete([{"role": "user", "content": "hi"}], lane="fast")
    assert out["provider"] == "groq" and ad["gemini"].calls == 0


def test_primary_429_falls_back(monkeypatch):
    """Acceptance C: kill the primary → request still succeeds via fallback, logged."""
    logs = []
    monkeypatch.setenv("AI_PROVIDER_ORDER", "groq,gemini,openrouter")
    r, ad = _router(("groq", "429"), ("gemini", "ok"), ("openrouter", "ok"),
                    log=lambda **kw: logs.append(kw))
    out = r.complete([{"role": "user", "content": "hi"}], lane="fast")
    assert out["provider"] == "gemini"
    assert ad["groq"].calls == 1 and ad["gemini"].calls == 1
    success = [l for l in logs if l["status"] == "ok"][0]
    assert success["provider"] == "gemini" and success["fallback_from"] == "groq"


def test_chain_of_failures_then_success(monkeypatch):
    monkeypatch.setenv("AI_PROVIDER_ORDER", "groq,gemini,openrouter,cloudflare")
    r, ad = _router(("groq", "429"), ("gemini", "500"), ("openrouter", "network"),
                    ("cloudflare", "ok"))
    out = r.complete([{"role": "user", "content": "hi"}])
    assert out["provider"] == "cloudflare"
    assert all(ad[n].calls == 1 for n in ("groq", "gemini", "openrouter", "cloudflare"))


def test_all_providers_fail_raises(monkeypatch):
    monkeypatch.setenv("AI_PROVIDER_ORDER", "groq,gemini")
    r, _ = _router(("groq", "429"), ("gemini", "500"))
    with pytest.raises(ProviderError) as e:
        r.complete([{"role": "user", "content": "hi"}])
    assert e.value.kind == "all_providers_failed"


def test_exhausted_budget_skips_to_next(monkeypatch):
    monkeypatch.setenv("AI_PROVIDER_ORDER", "groq,gemini")
    r, ad = _router(("groq", "exhausted"), ("gemini", "ok"))
    out = r.complete([{"role": "user", "content": "hi"}])
    assert out["provider"] == "gemini"


def test_quality_lane_degrades_to_free(monkeypatch):
    """Quality lane exhausts its own chain, then degrades to the free chain — never dies silently."""
    monkeypatch.setenv("AI_QUALITY_PROVIDER", "anthropic")
    monkeypatch.setenv("AI_PROVIDER_ORDER", "groq,gemini")
    r, ad = _router(("anthropic", "429"), ("groq", "ok"), ("gemini", "ok"))
    out = r.complete([{"role": "user", "content": "hi"}], lane="quality")
    assert out["provider"] == "groq" and ad["anthropic"].calls == 1


def test_unexpected_adapter_error_falls_over(monkeypatch):
    """A raw non-ProviderError from an adapter must fail over, not abort the chain."""
    monkeypatch.setenv("AI_PROVIDER_ORDER", "groq,gemini")
    r, ad = _router(("groq", "boom"), ("gemini", "ok"))
    out = r.complete([{"role": "user", "content": "hi"}])
    assert out["provider"] == "gemini"
    assert ad["groq"].calls == 1 and ad["gemini"].calls == 1


def test_deny_list_excludes_provider(monkeypatch):
    """deny= removes a provider from the chain for that request (behavioral rule 6:
    contact-bearing prompts never reach a provider that trains on prompts)."""
    monkeypatch.setenv("AI_PROVIDER_ORDER", "gemini,groq")
    r, ad = _router(("gemini", "ok"), ("groq", "ok"))
    out = r.complete([{"role": "user", "content": "phone for X"}], deny=SENSITIVE_DENY)
    assert out["provider"] == "groq"          # gemini was skipped entirely
    assert ad["gemini"].calls == 0


def test_deny_all_providers_raises(monkeypatch):
    """If deny empties the chain, fail loudly rather than silently returning nothing."""
    monkeypatch.setenv("AI_PROVIDER_ORDER", "gemini")
    r, _ = _router(("gemini", "ok"))
    with pytest.raises(ProviderError) as e:
        r.complete([{"role": "user", "content": "hi"}], deny=("gemini",))
    assert e.value.kind == "all_providers_failed"
