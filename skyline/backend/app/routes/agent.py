"""agent.py — the knowledge-base agent (blueprint §10-12).

Two-stage pipeline, portable across all six providers (JSON planning instead of
provider-specific function-calling, since free tiers vary in tool-call support —
this mirrors the artifact's proven callClaude(criteria)->score->callClaude(synth) shape):

  1. PLAN (fast lane, json_mode): question + tool catalog -> {tool, arguments}
  2. EXECUTE the chosen tool deterministically (SQL)
  3. SYNTHESIZE (quality lane, degrades to free): narrate the rows, cite them,
     never invent contact info, state public-record limits honestly.

Contact values shown to the user come only from tool rows, never from model prose.
"""
import json
from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from typing import Optional, List
from ..services import agent_tools
from ..services.ai import get_router
from ..services.provider_router import ProviderError

router = APIRouter(prefix="/api")


def _catalog():
    lines = []
    for name, (_, spec) in agent_tools.TOOLS.items():
        props = spec.get("parameters", {}).get("properties", {})
        args = ", ".join(props.keys()) or "(none)"
        lines.append(f"- {name}({args}): {spec['description']}")
    return "\n".join(lines)


PLANNER_SYSTEM = """You are the planner for a NYC commercial real-estate deal database.
Pick the single best tool to answer the user's question and extract its arguments.
Neighborhood names map to boroughs (e.g. Williamsburg/Bushwick->Brooklyn, Astoria/LIC->Queens,
Harlem/SoHo/Tribeca->Manhattan, Riverdale/Fordham->Bronx).
Asset types are exactly one of: Multifamily, Office, Retail, Industrial, Hotel, Mixed-Use,
Development Site, Garage/Auto, Commercial, Storage.
Respond with ONLY a JSON object: {"tool": "<name>", "arguments": {...}, "why": "<short>"}.
If no tool fits, use {"tool": "run_readonly_sql", "arguments": {"sql": "<SELECT ...>"}}.

Available tools:
%s"""

SYNTH_SYSTEM = """You are a NYC commercial real-estate analyst answering from database rows.
Rules:
- Answer ONLY from the provided tool result. Do not invent buyers, prices, phones, or emails.
- If a contact has no phone/email on file, say so plainly and note that public records
  (ACRIS/PLUTO) cap at mailing addresses; phone/email exist only if published or uploaded.
- When ranking buyers, cite their real track record (deal counts, volume, recent deals) and
  discount single-purpose LLCs named after a single address.
- Cite specifics (entity names, addresses, shortcodes) so the user can verify.
- Be concise and direct. If the data is thin, say what's missing rather than padding."""


def _plan(question: str, history: List[dict]):
    router_ = get_router()
    msgs = [{"role": "system", "content": PLANNER_SYSTEM % _catalog()}]
    for h in history[-6:]:
        msgs.append({"role": h["role"], "content": h["content"]})
    msgs.append({"role": "user", "content": question})
    out = router_.complete(msgs, lane="fast", purpose="plan", json_mode=True, max_tokens=400)
    raw = out["text"].strip()
    # tolerate ```json fences or leading prose
    if "```" in raw:
        raw = raw.split("```")[1].replace("json", "", 1).strip() if raw.count("```") >= 2 else raw
    start, end = raw.find("{"), raw.rfind("}")
    plan = json.loads(raw[start:end + 1]) if start >= 0 else {"tool": "run_readonly_sql",
                                                              "arguments": {"sql": "SELECT 1"}}
    return plan, out.get("provider")


def _synthesize(question: str, plan: dict, result: dict, history: List[dict]):
    router_ = get_router()
    msgs = [{"role": "system", "content": SYNTH_SYSTEM}]
    for h in history[-6:]:
        msgs.append({"role": h["role"], "content": h["content"]})
    msgs.append({"role": "user", "content":
        f"Question: {question}\n\nTool used: {plan.get('tool')}\n"
        f"Tool result (JSON):\n{json.dumps(result, default=str)[:6000]}\n\n"
        "Answer the question from this result."})
    out = router_.complete(msgs, lane="quality", purpose="synthesize", max_tokens=900)
    return out["text"], out.get("provider")


class AgentQuery(BaseModel):
    question: str
    history: Optional[List[dict]] = None
    user_id: Optional[str] = None


def _run(question, history):
    history = history or []
    plan, plan_provider = _plan(question, history)
    tool = plan.get("tool", "run_readonly_sql")
    args = plan.get("arguments", {}) or {}
    result = agent_tools.call_tool(tool, args)
    answer, synth_provider = _synthesize(question, plan, result, history)
    return {"tool": tool, "arguments": args, "plan_why": plan.get("why"),
            "result": result, "answer": answer,
            "providers": {"plan": plan_provider, "synthesis": synth_provider}}


@router.post("/agent")
def agent(q: AgentQuery):
    """Non-streaming: returns the plan, the raw tool rows (for citation/linking), and the answer."""
    try:
        return _run(q.question, q.history)
    except ProviderError as e:
        return {"error": "no_ai_provider_available", "detail": str(e),
                "hint": "Set at least one of GROQ_API_KEY / GEMINI_API_KEY / OPENROUTER_API_KEY / "
                        "CLOUDFLARE_* / ANTHROPIC_API_KEY / OPENAI_API_KEY."}


@router.post("/agent/stream")
def agent_stream(q: AgentQuery):
    """SSE: emits plan -> tool result -> streamed answer tokens. The tool rows are sent
    as a discrete event so the UI can render citations even if synthesis fails."""
    def gen():
        try:
            history = q.history or []
            plan, plan_provider = _plan(q.question, history)
            yield _sse("plan", {"tool": plan.get("tool"), "arguments": plan.get("arguments"),
                                "why": plan.get("why"), "provider": plan_provider})
            result = agent_tools.call_tool(plan.get("tool", "run_readonly_sql"),
                                           plan.get("arguments", {}) or {})
            yield _sse("result", result)
            answer, synth_provider = _synthesize(q.question, plan, result, history)
            yield _sse("answer", {"text": answer, "provider": synth_provider})
            yield _sse("done", {})
        except ProviderError as e:
            yield _sse("error", {"detail": str(e)})
    return StreamingResponse(gen(), media_type="text/event-stream")


def _sse(event, data):
    return f"event: {event}\ndata: {json.dumps(data, default=str)}\n\n"
