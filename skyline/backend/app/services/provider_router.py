"""provider_router.py — one adapter interface, env-keyed, ordered fallback.

Verified quotas (2026-07-02; re-verify before changing defaults):
  groq       free ~30 RPM / 1K-14.4K RPD (org-level)   -> primary fast/tool lane
  gemini     free Flash-only ~10-15 RPM / 250-1500 RPD -> secondary (may train on prompts:
                                                          NEVER route uploaded contact data here)
  openrouter 50 RPD free (1000 after one-time $10)     -> tertiary breadth
  cloudflare 10,000 neurons/day                        -> utility
  anthropic  no free tier (paid quality lane)
  openai     no free tier (optional quality lane)

Failover triggers: 429 / 5xx / timeout / connection error. Every attempt is logged
to ai_logs (provider, latency, fallback_from, status) — errors are recorded, never
swallowed. A provider whose in-process daily counter is exhausted is skipped
pre-emptively (Groq does not expose RPD in headers — we count ourselves).
"""
import os, time, json, threading
from dataclasses import dataclass, field
from typing import Optional
import httpx

# One pooled client for every adapter call — a fresh TCP+TLS handshake per
# request doubled latency on the 2-call agent pipeline.
_client = httpx.Client(timeout=30.0)

# Providers that may train on prompts. Behavioral rule 6: uploaded contact data
# must NEVER reach them — callers pass deny=SENSITIVE_DENY for any request whose
# messages can embed contacts rows.
SENSITIVE_DENY = ("gemini",)


class ProviderError(Exception):
    def __init__(self, provider, kind, detail=""):
        self.provider, self.kind, self.detail = provider, kind, detail
        super().__init__(f"{provider}: {kind} {detail}")


@dataclass
class Adapter:
    name: str
    base_url: str
    model: str
    api_key_env: str
    daily_budget: int                      # self-tracked RPD guard
    extra_headers: dict = field(default_factory=dict)
    _used_today: int = 0
    _day: str = ""
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    @property
    def configured(self):
        return bool(os.environ.get(self.api_key_env))

    def _budget_ok(self):
        # FastAPI serves sync endpoints from a threadpool; the counter and the
        # day rollover must not race.
        with self._lock:
            today = time.strftime("%Y-%m-%d")
            if today != self._day:
                self._day, self._used_today = today, 0
            return self._used_today < self.daily_budget

    def _count_use(self):
        with self._lock:
            self._used_today += 1

    def complete(self, messages, json_mode=False, max_tokens=1200, timeout=20.0):
        """OpenAI-compatible chat completion. Returns dict(text, input_tokens, output_tokens)."""
        if not self.configured:
            raise ProviderError(self.name, "not_configured")
        if not self._budget_ok():
            raise ProviderError(self.name, "daily_budget_exhausted")
        headers = {"Authorization": f"Bearer {os.environ[self.api_key_env]}",
                   "Content-Type": "application/json", **self.extra_headers}
        body = {"model": self.model, "messages": messages, "max_tokens": max_tokens}
        if json_mode:
            body["response_format"] = {"type": "json_object"}
        t0 = time.time()
        try:
            r = _client.post(f"{self.base_url}/chat/completions", headers=headers,
                             json=body, timeout=timeout)
        except httpx.HTTPError as e:
            raise ProviderError(self.name, "network", str(e))
        self._count_use()
        if r.status_code == 429:
            raise ProviderError(self.name, "rate_limited", r.text[:200])
        if r.status_code >= 500:
            raise ProviderError(self.name, "server_error", f"HTTP {r.status_code}")
        if r.status_code != 200:
            raise ProviderError(self.name, "http_error", f"HTTP {r.status_code} {r.text[:200]}")
        # A 200 with an unexpected body (OpenRouter error envelopes, Cloudflare
        # shape drift) must fail over like any other provider error, not 500.
        try:
            data = r.json()
            usage = data.get("usage") or {}
            return {"text": data["choices"][0]["message"]["content"],
                    "latency_ms": int((time.time() - t0) * 1000),
                    "input_tokens": usage.get("prompt_tokens"),
                    "output_tokens": usage.get("completion_tokens")}
        except (ValueError, KeyError, IndexError, TypeError) as e:
            raise ProviderError(self.name, "bad_response", f"{type(e).__name__}: {r.text[:200]}")


class AnthropicAdapter(Adapter):
    """Anthropic's native /v1/messages (not OpenAI-shaped)."""
    def complete(self, messages, json_mode=False, max_tokens=1200, timeout=30.0):
        if not self.configured:
            raise ProviderError(self.name, "not_configured")
        if not self._budget_ok():
            raise ProviderError(self.name, "daily_budget_exhausted")
        system = "\n".join(m["content"] for m in messages if m["role"] == "system") or None
        convo = [m for m in messages if m["role"] != "system"]
        body = {"model": self.model, "max_tokens": max_tokens, "messages": convo}
        if system:
            body["system"] = system
        t0 = time.time()
        try:
            r = _client.post(f"{self.base_url}/v1/messages", json=body, timeout=timeout,
                             headers={"x-api-key": os.environ[self.api_key_env],
                                      "anthropic-version": "2023-06-01",
                                      "Content-Type": "application/json"})
        except httpx.HTTPError as e:
            raise ProviderError(self.name, "network", str(e))
        self._count_use()
        if r.status_code == 429:
            raise ProviderError(self.name, "rate_limited", r.text[:200])
        if r.status_code >= 500:
            raise ProviderError(self.name, "server_error", f"HTTP {r.status_code}")
        if r.status_code != 200:
            raise ProviderError(self.name, "http_error", f"HTTP {r.status_code} {r.text[:200]}")
        try:
            data = r.json()
            text = "".join(c.get("text", "") for c in data.get("content", []) if c.get("type") == "text")
            usage = data.get("usage") or {}
            return {"text": text, "latency_ms": int((time.time() - t0) * 1000),
                    "input_tokens": usage.get("input_tokens"), "output_tokens": usage.get("output_tokens")}
        except (ValueError, KeyError, TypeError) as e:
            raise ProviderError(self.name, "bad_response", f"{type(e).__name__}: {r.text[:200]}")


def default_adapters():
    return {
        "groq": Adapter("groq", "https://api.groq.com/openai/v1",
                        os.environ.get("GROQ_MODEL", "llama-3.3-70b-versatile"),
                        "GROQ_API_KEY", daily_budget=900),
        "gemini": Adapter("gemini", "https://generativelanguage.googleapis.com/v1beta/openai",
                          os.environ.get("GEMINI_MODEL", "gemini-2.5-flash"),
                          "GEMINI_API_KEY", daily_budget=220),
        "openrouter": Adapter("openrouter", "https://openrouter.ai/api/v1",
                              os.environ.get("OPENROUTER_MODEL", "meta-llama/llama-3.3-70b-instruct:free"),
                              "OPENROUTER_API_KEY", daily_budget=45),
        "cloudflare": Adapter("cloudflare",
                              f"https://api.cloudflare.com/client/v4/accounts/{os.environ.get('CLOUDFLARE_ACCOUNT_ID','_')}/ai/v1",
                              os.environ.get("CLOUDFLARE_MODEL", "@cf/meta/llama-3.1-8b-instruct"),
                              "CLOUDFLARE_API_TOKEN", daily_budget=15),
        "openai": Adapter("openai", "https://api.openai.com/v1",
                          os.environ.get("OPENAI_MODEL", "gpt-4o-mini"),
                          "OPENAI_API_KEY", daily_budget=100000),
        "anthropic": AnthropicAdapter("anthropic", "https://api.anthropic.com",
                                      os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-4-6"),
                                      "ANTHROPIC_API_KEY", daily_budget=100000),
    }


class Router:
    def __init__(self, adapters=None, log_fn=None):
        self.adapters = adapters or default_adapters()
        self.log_fn = log_fn or (lambda **kw: None)

    def _chain(self, env_var, default):
        return [n.strip() for n in os.environ.get(env_var, default).split(",") if n.strip()]

    def complete(self, messages, lane="fast", purpose="chat", json_mode=False, max_tokens=1200,
                 deny=()):
        """deny: provider names excluded from the chain for THIS request. Pass
        SENSITIVE_DENY whenever the messages can embed contacts rows (behavioral
        rule 6: no uploaded contact data to providers that train on prompts)."""
        chain = self._chain("AI_QUALITY_PROVIDER", "anthropic,openai") if lane == "quality" \
            else self._chain("AI_PROVIDER_ORDER", "groq,gemini,openrouter,cloudflare")
        if lane == "quality":
            chain += [n for n in self._chain("AI_PROVIDER_ORDER", "groq,gemini,openrouter,cloudflare")
                      if n not in chain]          # quality lane degrades to free lane, never dies silently
        chain = [n for n in chain if n not in deny]
        errors, fallback_from = [], None
        for name in chain:
            ad = self.adapters.get(name)
            if not ad or not ad.configured:
                continue
            try:
                out = ad.complete(messages, json_mode=json_mode, max_tokens=max_tokens)
                self.log_fn(provider=name, model=ad.model, purpose=purpose,
                            latency_ms=out["latency_ms"], input_tokens=out["input_tokens"],
                            output_tokens=out["output_tokens"], fallback_from=fallback_from,
                            status="ok")
                out["provider"] = name
                return out
            except ProviderError as e:
                errors.append(str(e))
                self.log_fn(provider=name, model=ad.model, purpose=purpose,
                            latency_ms=None, input_tokens=None, output_tokens=None,
                            fallback_from=fallback_from, status=f"error:{e.kind}")
                fallback_from = name
        raise ProviderError("router", "all_providers_failed", "; ".join(errors) or "no providers configured")
