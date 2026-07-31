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

# 백만 토큰당 USD. TS 쪽 lib/llm/models.ts 와 값이 일치해야 한다.
# Gemini 는 무료 티어로 쓰더라도 **유료 단가**를 적는다. 0 으로 두면 예산 상한이
# 무력화되고, 나중에 결제를 켜는 순간 안전장치 없이 과금된다.
PRICING = {
    "claude-haiku-4-5": (1.0, 5.0),
    "claude-sonnet-5": (3.0, 15.0),
    "gpt-5-mini": (0.25, 2.0),
    "gpt-5": (1.25, 10.0),
    "gemini-3.1-flash-lite": (0.25, 1.5),
    "gemini-3.5-flash": (1.5, 9.0),
}

EMBEDDING_MODEL = "text-embedding-3-small"
EMBEDDING_DIMENSIONS = 1536
EMBEDDING_PRICE_PER_MTOK = 0.02

# Gemini 임베딩. 출력 차원을 1536 으로 맞춰야 DB(vector(1536)) 와 호환된다.
GEMINI_EMBEDDING_MODEL = "gemini-embedding-001"

# Gemini responseJsonSchema 가 받지 않는 키워드. 남기면 400 이 떨어진다.
_GEMINI_UNSUPPORTED = {
    "additionalProperties", "$schema", "$ref", "$defs",
    "minLength", "maxLength", "minimum", "maximum",
    "minItems", "maxItems", "exclusiveMinimum", "exclusiveMaximum",
}


def _strip_for_gemini(node: Any) -> Any:
    if isinstance(node, list):
        return [_strip_for_gemini(item) for item in node]
    if isinstance(node, dict):
        return {k: _strip_for_gemini(v) for k, v in node.items() if k not in _GEMINI_UNSUPPORTED}
    return node


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
    if provider == "gemini":
        return _gemini_structured(system, user, schema, tier)
    return _anthropic_structured(system, user, schema, tier)


def _gemini_structured(system: str, user: str, schema: dict, tier: str) -> LlmResult:
    """Google AI Studio. 무료 티어라 한도를 넘기면 과금이 아니라 429 가 온다."""
    from google import genai
    from google.genai import types

    model = "gemini-3.5-flash" if tier == "standard" else "gemini-3.1-flash-lite"
    client = genai.Client(api_key=require("GEMINI_API_KEY"))

    response = client.models.generate_content(
        model=model,
        contents=user,
        config=types.GenerateContentConfig(
            system_instruction=system,
            response_mime_type="application/json",
            response_json_schema=_strip_for_gemini(schema),
            max_output_tokens=8000,
            # Gemini 3.x 는 기본으로 사고를 켜는데, 사고 토큰이 max_output_tokens 를
            # 같이 소모해서 본문 JSON 이 잘린다. 사고 토큰은 출력 단가로 과금까지 된다.
            thinking_config=types.ThinkingConfig(thinking_budget=0),
        ),
    )

    finish_reason = response.candidates[0].finish_reason if response.candidates else "unknown"
    text = response.text
    if not text:
        # 응답이 비는 대표 원인은 안전필터 차단과 max_output_tokens 초과다.
        raise RuntimeError(f"Gemini 응답이 비었습니다 (finish_reason={finish_reason}).")
    # 잘린 응답은 JSON 파싱 오류로 보이지만 원인은 스키마가 아니라 한도다.
    if str(finish_reason).endswith("MAX_TOKENS"):
        raise RuntimeError("Gemini 응답이 max_output_tokens 에서 잘렸습니다. 한도를 올리십시오.")

    usage = response.usage_metadata
    input_tokens = getattr(usage, "prompt_token_count", 0) or 0
    # 사고 토큰도 출력 단가로 과금된다. 빠뜨리면 비용이 과소집계된다.
    output_tokens = (getattr(usage, "candidates_token_count", 0) or 0) + (
        getattr(usage, "thoughts_token_count", 0) or 0
    )
    return LlmResult(
        data=json.loads(text),
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        cost_usd=_cost(model, input_tokens, output_tokens),
        provider="gemini",
        model=model,
    )


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
    """LLM_PROVIDER 가 gemini 면 Gemini, 아니면 OpenAI.

    Anthropic 은 임베딩 API 가 없어서 OpenAI 로 넘긴다.
    어느 쪽이든 1536 차원이어야 DB(vector(1536)) 와 맞는다.
    """
    if not texts:
        return []

    if optional("LLM_PROVIDER", "anthropic") == "gemini":
        from google import genai
        from google.genai import types

        client = genai.Client(api_key=require("GEMINI_API_KEY"))
        response = client.models.embed_content(
            model=GEMINI_EMBEDDING_MODEL,
            contents=texts,
            config=types.EmbedContentConfig(output_dimensionality=EMBEDDING_DIMENSIONS),
        )
        vectors = [list(e.values) for e in (response.embeddings or [])]
        if len(vectors) != len(texts):
            raise RuntimeError(f"Gemini 임베딩 개수 불일치: 요청 {len(texts)}, 응답 {len(vectors)}")
        for v in vectors:
            if len(v) != EMBEDDING_DIMENSIONS:
                raise RuntimeError(f"Gemini 임베딩 차원 불일치: {len(v)} (기대 {EMBEDDING_DIMENSIONS})")
        return vectors

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
