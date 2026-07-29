"""
Read-only QUERY registry — a SEPARATE path from the 25 action templates.

Actions (registry.py) build unsigned XDRs and run through slot validation → plan
→ risk gate → preview. QUERIES do none of that: each maps to a SINGLE MCP read
tool, calls it, and hands the raw result to the LLM for a plain-English answer.
No XDR, no risk gate, no preview.

A QueryTemplate shares the ParsedIntent shape with actions (template_id + slots),
so the same intent parser can emit either. The pipeline tells them apart by id
(queries.get(id) is not None → query branch).

Argument mapping note: `slot_map` documents each query's slot→param translation,
but the RUNTIME source of truth for real tool parameter names is the planner's
per-tool TOOL_ARGS table (app/orchestrator/planner.py) — the pipeline resolves
args through planner.resolve_args() so queries and actions never drift apart.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class QueryTemplate:
    id: str
    intent_phrase: str                 # canonical phrasing used for matching + few-shot
    tool: str                          # the single MCP read tool this query calls
    slot_map: dict[str, str] = field(default_factory=dict)  # slot name -> tool param
    required_slots: tuple[str, ...] = ()
    requires_account: bool = False     # needs a resolved smart_account (no account layer yet)
    notes: str = ""


QUERIES: tuple[QueryTemplate, ...] = (
    QueryTemplate(
        id="query_pool_stats",
        intent_phrase="What are the current stats (APR / APY / utilization) for the {asset} pool?",
        tool="vanna_get_pool_stats",
        slot_map={"asset": "symbol"},
        required_slots=("asset",),
    ),
    QueryTemplate(
        id="query_price",
        intent_phrase="What is the current price of {asset}?",
        tool="vanna_get_price",
        slot_map={"asset": "symbol"},
        required_slots=("asset",),
    ),
    QueryTemplate(
        id="query_account_health",
        intent_phrase="What is the current health (health factor / leverage) of my account?",
        tool="vanna_get_account_health",
        slot_map={},  # scoped by account context (smart_account), not a slot
        required_slots=(),
        requires_account=True,
        notes="Requires a resolved smart_account; account layer not implemented yet.",
    ),
)

BY_ID: dict[str, QueryTemplate] = {q.id: q for q in QUERIES}


def all_queries() -> tuple[QueryTemplate, ...]:
    return QUERIES


def get(query_id: str | None) -> QueryTemplate | None:
    if not query_id:
        return None
    return BY_ID.get(query_id)


def query_ids() -> list[str]:
    return [q.id for q in QUERIES]
