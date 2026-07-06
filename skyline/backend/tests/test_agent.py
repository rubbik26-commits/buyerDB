"""Agent pipeline test: scripted router (no real key) + real Postgres tools.
Proves the two-stage wiring: planner JSON -> deterministic tool -> grounded synthesis.
Run: pytest backend/tests/test_agent.py -v"""
import os, sys, json
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
os.environ.setdefault("DATABASE_URL", "postgresql://skyline:skyline_dev@localhost/skyline")

from backend.app.services import ai
from backend.app.routes import agent


class ScriptedRouter:
    """Returns a plan on the 'plan' purpose and a narration on 'synthesize'."""
    def __init__(self, plan):
        self._plan = plan
        self.seen_synth_result = None

    def complete(self, messages, lane="fast", purpose="chat", json_mode=False, max_tokens=1200):
        if purpose == "plan":
            return {"text": json.dumps(self._plan), "provider": "scripted-fast",
                    "latency_ms": 1, "input_tokens": 1, "output_tokens": 1}
        # synthesize: echo a short grounded answer referencing the tool result it was given
        user = messages[-1]["content"]
        self.seen_synth_result = user
        return {"text": "Based on the rows: top candidate identified.", "provider": "scripted-quality",
                "latency_ms": 1, "input_tokens": 1, "output_tokens": 1}


def _patch(monkeypatch, plan):
    r = ScriptedRouter(plan)
    monkeypatch.setattr(ai, "get_router", lambda: r)
    monkeypatch.setattr(agent, "get_router", lambda: r)
    return r


def test_best_buyer_pipeline(monkeypatch):
    r = _patch(monkeypatch, {"tool": "find_similar_buyers",
                             "arguments": {"asset_type": "Multifamily", "borough": "Brooklyn", "price": 3000000},
                             "why": "matching buyers"})
    out = agent._run("Who's the best buyer for a Brooklyn multifamily around $3M?", [])
    assert out["tool"] == "find_similar_buyers"
    assert out["result"]["candidates"], "tool returned real candidates from DB"
    # the synthesis step was actually handed the real rows
    assert "candidates" in r.seen_synth_result
    assert out["answer"].startswith("Based on the rows")


def test_phone_lookup_pipeline(monkeypatch):
    _patch(monkeypatch, {"tool": "lookup_contact",
                         "arguments": {"entity_name": "TOWNHOUSE RENTAL II, L.L.C."}, "why": "phone"})
    out = agent._run("What's the phone number for Townhouse Rental II?", [])
    assert out["tool"] == "lookup_contact"
    # the deterministic tool supplies the contact; the model never invents it
    matches = out["result"]["matches"]
    assert matches and matches[0]["name"] == "TOWNHOUSE RENTAL II, L.L.C."


def test_malformed_plan_falls_back_to_sql(monkeypatch):
    # planner returns prose around JSON — the extractor must still recover the object
    class MessyRouter(ScriptedRouter):
        def complete(self, messages, lane="fast", purpose="chat", json_mode=False, max_tokens=1200):
            if purpose == "plan":
                return {"text": 'Sure! ```json\n{"tool":"recent_changes","arguments":{"days":30}}\n```',
                        "provider": "x", "latency_ms": 1, "input_tokens": 1, "output_tokens": 1}
            return {"text": "ok", "provider": "y", "latency_ms": 1, "input_tokens": 1, "output_tokens": 1}
    r = MessyRouter({})
    monkeypatch.setattr(ai, "get_router", lambda: r)
    monkeypatch.setattr(agent, "get_router", lambda: r)
    out = agent._run("what changed recently?", [])
    assert out["tool"] == "recent_changes" and out["arguments"] == {"days": 30}
