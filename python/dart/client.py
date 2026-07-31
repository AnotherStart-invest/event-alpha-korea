"""OpenDART API 클라이언트.

알려진 제약 (RISK 2.2):
- 일 20,000 콜
- corpCode.xml 은 zip 으로 오고, 약 10만 건 중 대부분이 비상장이다
- document.xml 도 zip 이며 인코딩이 EUC-KR / UTF-8 로 섞여 있다
- 정형 API 로는 "사업의 내용"을 얻을 수 없다 → 원문 파싱이 필수 경로다
"""
from __future__ import annotations

import io
import time
import zipfile
from dataclasses import dataclass
from typing import Any, Iterator
from xml.etree import ElementTree

import requests

from ..common.config import CACHE_DIR, require
from ..common.log import Logger

BASE = "https://opendart.fss.or.kr/api"
log = Logger("dart")


class DartError(RuntimeError):
    pass


@dataclass(frozen=True)
class CorpEntry:
    corp_code: str
    corp_name: str
    stock_code: str | None
    modify_date: str


def _key() -> str:
    return require("OPENDART_API_KEY")


def _get(path: str, **params: Any) -> requests.Response:
    """지수 백오프 3회. 4xx 는 즉시 실패."""
    url = f"{BASE}/{path}"
    params = {"crtfc_key": _key(), **params}

    delay = 1.0
    for attempt in range(3):
        response = requests.get(url, params=params, timeout=30)
        if response.status_code < 400:
            return response
        if response.status_code < 500 and response.status_code != 429:
            raise DartError(f"{path} 실패 ({response.status_code}): {response.text[:200]}")
        if attempt < 2:
            time.sleep(delay)
            delay *= 4
    raise DartError(f"{path} 재시도 소진")


def _check_status(payload: dict) -> dict:
    """OpenDART 는 HTTP 200 에 status 코드로 오류를 알린다."""
    status = payload.get("status")
    if status == "000":
        return payload
    if status == "013":  # 조회 결과 없음 — 정상 상황
        return {"status": status, "list": []}
    raise DartError(f"OpenDART 오류 {status}: {payload.get('message')}")


def fetch_corp_codes(use_cache: bool = True) -> list[CorpEntry]:
    """전체 기업 코드. zip → CORPCODE.xml 파싱.

    stock_code 가 공백인 행이 대다수(비상장)이므로 호출부에서 반드시 필터링한다.
    """
    cache = CACHE_DIR / "corpCode.zip"

    if use_cache and cache.exists():
        raw = cache.read_bytes()
        log.info("corpCode 캐시 사용", path=str(cache))
    else:
        response = _get("corpCode.xml")
        raw = response.content
        if raw[:2] != b"PK":
            raise DartError(f"zip 이 아닌 응답: {raw[:200]!r}")
        cache.write_bytes(raw)
        log.info("corpCode 내려받음", bytes=len(raw))

    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        name = next(n for n in archive.namelist() if n.upper().endswith(".XML"))
        xml_bytes = archive.read(name)

    root = ElementTree.fromstring(xml_bytes)
    entries: list[CorpEntry] = []
    for node in root.iter("list"):
        stock = (node.findtext("stock_code") or "").strip()
        entries.append(
            CorpEntry(
                corp_code=(node.findtext("corp_code") or "").strip(),
                corp_name=(node.findtext("corp_name") or "").strip(),
                stock_code=stock if stock else None,
                modify_date=(node.findtext("modify_date") or "").strip(),
            )
        )
    log.info("corpCode 파싱 완료", total=len(entries), listed=sum(1 for e in entries if e.stock_code))
    return entries


def fetch_company(corp_code: str) -> dict:
    """기업 개황 (업종코드, 법인명, 상장시장 등)."""
    payload = _check_status(_get("company.json", corp_code=corp_code).json())
    return payload


def find_latest_annual_report(corp_code: str, years_back: int = 2) -> dict | None:
    """최근 사업보고서(정기공시)의 접수번호를 찾는다.

    주의: rcept_no 를 다른 API 와 조인 키로 쓰지 말 것.
    선행 프로젝트(mezzanine-tracker)에서 40% 어긋남을 확인했다.
    여기서는 원문 조회 용도로만 쓴다.
    """
    from datetime import date, timedelta

    end = date.today()
    begin = end - timedelta(days=365 * years_back)

    payload = _check_status(
        _get(
            "list.json",
            corp_code=corp_code,
            bgn_de=begin.strftime("%Y%m%d"),
            end_de=end.strftime("%Y%m%d"),
            pblntf_ty="A",  # 정기공시
            page_count=100,
        ).json()
    )

    reports = [
        item
        for item in payload.get("list", [])
        if "사업보고서" in (item.get("report_nm") or "")
    ]
    if not reports:
        return None
    reports.sort(key=lambda r: r.get("rcept_dt", ""), reverse=True)
    return reports[0]


def fetch_document_text(rcept_no: str) -> str:
    """공시 원문. zip 안의 XML 을 텍스트로 만든다.

    인코딩이 섞여 있어 UTF-8 → CP949 순으로 시도한다.
    """
    raw = _get("document.xml", rcept_no=rcept_no).content
    if raw[:2] != b"PK":
        raise DartError(f"원문 zip 이 아님: {raw[:200]!r}")

    texts: list[str] = []
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        for name in archive.namelist():
            if not name.lower().endswith((".xml", ".html", ".htm")):
                continue
            blob = archive.read(name)
            for encoding in ("utf-8", "cp949", "euc-kr"):
                try:
                    texts.append(blob.decode(encoding))
                    break
                except UnicodeDecodeError:
                    continue
    if not texts:
        raise DartError("원문에서 읽을 수 있는 문서를 찾지 못했습니다.")
    return "\n".join(texts)


def iter_listed(entries: list[CorpEntry]) -> Iterator[CorpEntry]:
    """상장사만."""
    for entry in entries:
        if entry.stock_code and len(entry.stock_code) == 6 and entry.stock_code.isdigit():
            yield entry
