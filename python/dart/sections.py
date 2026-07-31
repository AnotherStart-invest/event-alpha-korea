"""공시 원문에서 "사업의 내용" 구간만 잘라낸다.

원문 전체를 LLM 에 넣지 않는다는 것이 설계 원칙이다.
보고서 구조가 회사마다 달라 100% 동작하지 않으므로, 실패하면 건너뛰고 로그를 남긴다.
"""
from __future__ import annotations

import re

# XML/HTML 태그 제거
_TAG = re.compile(r"<[^>]+>")
_WS = re.compile(r"[ \t ]+")
_BLANK = re.compile(r"\n{3,}")

_START_PATTERNS = [
    r"II?\s*[.．]\s*사업의\s*내용",
    r"2\s*[.．]\s*사업의\s*내용",
    r"사업의\s*내용",
]
_END_PATTERNS = [
    r"III?\s*[.．]\s*재무에\s*관한\s*사항",
    r"3\s*[.．]\s*재무에\s*관한\s*사항",
    r"재무에\s*관한\s*사항",
    r"감사인의\s*감사의견",
]

MAX_SECTION_CHARS = 40_000
CHUNK_CHARS = 8_000


def strip_markup(raw: str) -> str:
    text = _TAG.sub("\n", raw)
    text = text.replace("&nbsp;", " ").replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")
    text = _WS.sub(" ", text)
    text = _BLANK.sub("\n\n", text)
    return text.strip()


def extract_business_section(raw_document: str) -> str | None:
    """'사업의 내용' 구간을 반환한다. 못 찾으면 None."""
    text = strip_markup(raw_document)

    start = None
    for pattern in _START_PATTERNS:
        match = re.search(pattern, text)
        if match:
            start = match.end()
            break
    if start is None:
        return None

    end = len(text)
    for pattern in _END_PATTERNS:
        match = re.search(pattern, text[start:])
        if match:
            end = start + match.start()
            break

    section = text[start:end].strip()
    if len(section) < 500:
        return None
    return section[:MAX_SECTION_CHARS]


def chunk_section(section: str, size: int = CHUNK_CHARS) -> list[str]:
    """문단 경계를 지키며 자른다. 문장이 잘리면 LLM 이 근거 문장을 못 옮긴다."""
    paragraphs = [p.strip() for p in section.split("\n\n") if p.strip()]
    chunks: list[str] = []
    current: list[str] = []
    length = 0

    for paragraph in paragraphs:
        if length + len(paragraph) > size and current:
            chunks.append("\n\n".join(current))
            current, length = [], 0
        current.append(paragraph)
        length += len(paragraph)

    if current:
        chunks.append("\n\n".join(current))
    return chunks
