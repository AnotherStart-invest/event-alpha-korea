"""LLM 추상화 (TS lib/llm 과 같은 계약).

structured output 은 API 레벨 파라미터로 직접 지정한다.
헬퍼 이름에 의존하지 않아 SDK 버전 변화에 덜 취약하다.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

from .config import optional, require
from .log import Logger

log = Logger("llm")

# 백만 토큰당 USD
PRICING = {
    "claude-haiku-4-5": (1.0, 5.0),
    "claude-sonnet-5": (3.0, 15.0),
    "gpt-5-mini": (0.25, 2.0),
    "gpt-5": (1.25, 10.0),
}

EMBEDDING_MODEL = "text-embedding-3-small"
EMBEDDING_DIMENSIONS = 1536
EMBEDDING_PRICE_PER_MTOK = 0.02


@dataclass
class LlmResult:
    data: dict
    input_tokens: int
    output_tokens: int
    cost_usd: float
    provider: str
    model: str


def _cost(model: str, input_tokens: int, output_tokens: int) -> float:
    price_in, price_out = PRICING.get(model, (0.0, 0.0))
    return (input_tokens / 1_000_000) * price_in + (output_tokens / 1_000_000) * price_out


def structured(system: str, user: str, schema: dict, schema_name: str, tier: str = "standard") -> LlmResult:
    provider = optional("LLM_PROVIDER", "anthropic")
    if provider == "openai":
        return _openai_structured(system, user, schema, schema_name, tier)
    return _anthropic_structured(system, user, schema, tier)


def _anthropic_structured(system: str, user: str, schema: dict, tier: str) -> LlmResult:
    import anthropic

    model = "claude-sonnet-5" if tier == "standard" else "claude-haiku-4-5"
    client = anthropic.Anthropic(api_key=require("ANTHROPIC_API_KEY"))

    kwargs: dict[str, Any] = {
        "model": model,
        "max_tokens": 8000,
        "system": system,
        "messages": [{"role": "user", "content": user}],
        "output_config": {"format": {"type": "json_schema", "schema": schema}},
    }
    # Haiku 4.5 는 effort / adaptive thinking 을 받지 않는다.
    if model == "claude-sonnet-5":
        kwargs["thinking"] = {"type": "disabled"}

    response = client.messages.create(**kwargs)

    if response.stop_reason == "refusal":
        raise RuntimeError("Anthropic 안전 필터가 요청을 거부했습니다.")

    text = "".join(block.text for block in response.content if block.type == "text")
    return LlmResult(
        data=json.loads(text),
        input_tokens=response.usage.input_tokens,
        output_tokens=response.usage.output_tokens,
        cost_usd=_cost(model, response.usage.input_tokens, response.usage.output_tokens),
        provider="anthropic",
        model=model,
    )


def _openai_structured(system: str, user: str, schema: dict, schema_name: str, tier: str) -> LlmResult:
    from openai import OpenAI

    model = "gpt-5" if tier == "standard" else "gpt-5-mini"
    client = OpenAI(api_key=require("OPENAI_API_KEY"))

    response = client.chat.completions.create(
        model=model,
        messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
        response_format={
            "type": "json_schema",
            "json_schema": {"name": schema_name, "schema": schema, "strict": True},
        },
    )
    usage = response.usage
    return LlmResult(
        data=json.loads(response.choices[0].message.content or "{}"),
        input_tokens=usage.prompt_tokens if usage else 0,
        output_tokens=usage.completion_tokens if usage else 0,
        cost_usd=_cost(model, usage.prompt_tokens if usage else 0, usage.completion_tokens if usage else 0),
        provider="openai",
        model=model,
    )


def embed(texts: list[str]) -> list[list[float]]:
    """임베딩은 항상 OpenAI. Anthropic 이 임베딩 API 를 제공하지 않는다."""
    if not texts:
        return []
    from openai import OpenAI

    client = OpenAI(api_key=require("OPENAI_API_KEY"))
    response = client.embeddings.create(
        model=EMBEDDING_MODEL, input=texts, dimensions=EMBEDDING_DIMENSIONS
    )
    ordered = sorted(response.data, key=lambda d: d.index)
    return [d.embedding for d in ordered]


def record_call(supabase, purpose: str, result: LlmResult, company_id: str | None = None) -> None:
    """llm_calls 에 비용을 남긴다. 실패해도 파이프라인을 죽이지 않는다."""
    try:
        supabase.table("llm_calls").insert(
            {
                "purpose": purpose,
                "provider": result.provider,
                "model": result.model,
                "company_id": company_id,
                "input_tokens": result.input_tokens,
                "output_tokens": result.output_tokens,
                "estimated_cost_usd": result.cost_usd,
                "ok": True,
            }
        ).execute()
    except Exception as err:  # noqa: BLE001
        log.warn("비용 기록 실패", err=str(err))


def today_cost(supabase) -> float:
    try:
        response = supabase.table("v_llm_cost_today").select("cost_usd").limit(1).execute()
        rows = response.data or []
        return float(rows[0]["cost_usd"]) if rows else 0.0
    except Exception:  # noqa: BLE001
        return 0.0


def daily_budget(supabase) -> float:
    try:
        response = supabase.table("app_settings").select("daily_llm_budget_usd").eq("id", 1).execute()
        rows = response.data or []
        return float(rows[0]["daily_llm_budget_usd"]) if rows else 3.0
    except Exception:  # noqa: BLE001
        return 3.0
