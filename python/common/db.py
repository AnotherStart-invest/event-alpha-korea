"""Supabase service_role 클라이언트.

RLS 를 우회하므로 이 모듈은 절대 배포되는 웹 코드에서 import 하지 않는다.
"""
from __future__ import annotations

import re
import unicodedata
from functools import lru_cache

from supabase import Client, create_client

from .config import require


@lru_cache(maxsize=1)
def get_client() -> Client:
    return create_client(require("NEXT_PUBLIC_SUPABASE_URL"), require("SUPABASE_SERVICE_ROLE_KEY"))


_NON_SEARCHABLE = re.compile(r"[^0-9a-z가-힣]")


def normalize_term(value: str) -> str:
    """lib/matching/normalize.ts 의 normalizeTerm 과 **반드시 동일한 규칙**.

    어긋나면 정확 일치 매칭이 통째로 실패한다.
    """
    folded = unicodedata.normalize("NFKC", value).lower()
    return _NON_SEARCHABLE.sub("", folded)


def chunked(items: list, size: int):
    for i in range(0, len(items), size):
        yield items[i : i + size]
