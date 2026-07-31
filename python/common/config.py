"""환경변수 로딩과 공통 설정.

Windows 콘솔 인코딩 문제(RISK 4.4)를 피하기 위해 stdout 을 UTF-8 로 강제한다.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[2]

# .env.local 을 우선 읽고, 없으면 .env
for name in (".env.local", ".env"):
    candidate = ROOT / name
    if candidate.exists():
        load_dotenv(candidate, override=False)

CACHE_DIR = ROOT / "python" / ".cache"
CACHE_DIR.mkdir(parents=True, exist_ok=True)


def force_utf8_stdout() -> None:
    """한글 출력이 깨지지 않게 한다. 스크립트 진입점에서 호출."""
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")


def require(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise SystemExit(
            f"환경변수 {name} 가 설정되지 않았습니다. .env.example 을 참고해 .env.local 에 추가하세요."
        )
    return value


def optional(name: str, default: str = "") -> str:
    return os.environ.get(name) or default
