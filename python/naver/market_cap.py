"""네이버 금융 시가총액 클라이언트.

왜 KRX 가 아닌가:
  KRX 정보데이터시스템(data.krx.co.kr)의 MDCSTAT01501 이 정석이지만, 세션 없이
  POST 하면 본문에 `LOGOUT` 만 돌아온다. 인덱스 페이지로 쿠키를 먼저 받아도,
  http/https 를 바꿔도 같다. 무인증 경로가 막혀 있다.

  네이버 금융의 시가총액 순위 페이지는 인증 없이 전 종목을 준다. 한 페이지에
  50종목이라 KOSPI+KOSDAQ 이 60페이지 남짓이고, 몇 초면 끝난다.

함정:
- 응답이 **EUC-KR** 이다. UTF-8 로 읽으면 종목명이 통째로 깨진다.
- 시가총액 단위가 **억원**, 상장주식수 단위가 **천주**다. 그대로 저장하면
  삼성전자 시총이 1,534만원이 된다. 여기서 원/주 단위로 되돌려 내보낸다.
- `<td class="number">` 셀 중 전일비·등락률은 안에 `<span>` 이 들어 있어
  줄바꿈이 섞인다. 숫자만 정규식으로 훑으면 이 두 칸이 통째로 빠져
  시가총액 자리가 밀린다. 셀 단위로 자른 뒤 태그를 걷어내야 한다.
- 우선주(삼성전자우 등)도 별도 종목코드로 나온다. companies 에 그 코드가
  없으면 그냥 매칭이 안 될 뿐이라 따로 거르지 않는다.
"""
from __future__ import annotations

import re
import time
from dataclasses import dataclass

import requests

LIST_URL = "https://finance.naver.com/sise/sise_market_sum.naver"

# sosok=0 유가증권, 1 코스닥. 코넥스는 이 페이지에 없다 — 시총이 없어도
# 화면에서 최하단으로 밀리므로 굳이 다른 소스를 붙이지 않는다.
MARKETS = {0: "KOSPI", 1: "KOSDAQ"}

# 한 시장에서 넘길 최대 페이지. 코스닥이 1,800종목 남짓이라 40이면 충분하지만,
# 상장이 늘어도 멈추지 않도록 여유를 둔다. 빈 페이지를 만나면 어차피 조기 종료한다.
MAX_PAGES = 60

_ROW = re.compile(r"<tr[^>]*>(.*?)</tr>", re.S | re.I)
_CELL = re.compile(r'<td[^>]*class="number"[^>]*>(.*?)</td>', re.S | re.I)
_CODE = re.compile(r'href="/item/main\.naver\?code=([0-9]{6})"[^>]*class="tltle"[^>]*>(.*?)</a>', re.S)
_TAG = re.compile(r"<[^>]*>")

# td.number 안에서의 자리. 헤더 순서와 일치한다:
#   현재가 · 전일비 · 등락률 · 액면가 · 시가총액 · 상장주식수 · 외국인비율 · …
_PRICE, _MARKET_CAP, _SHARES = 0, 4, 5
_MIN_CELLS = 6


@dataclass(frozen=True)
class NaverQuote:
    stock_code: str
    company_name: str
    market: str
    """시가총액(원). 페이지의 억원 표기를 되돌린 값."""
    market_cap: int
    """상장주식수(주). 페이지의 천주 표기를 되돌린 값."""
    shares_outstanding: int
    close_price: int


def fetch_quotes(sleep: float = 0.2, timeout: int = 20) -> list[NaverQuote]:
    """KOSPI·KOSDAQ 전 종목의 시총을 가져온다. 약 2,700건."""
    session = requests.Session()
    session.headers["User-Agent"] = "Mozilla/5.0"
    session.headers["Referer"] = LIST_URL

    quotes: list[NaverQuote] = []
    seen: set[str] = set()

    for sosok, market in MARKETS.items():
        for page in range(1, MAX_PAGES + 1):
            response = session.get(
                LIST_URL, params={"sosok": sosok, "page": page}, timeout=timeout
            )
            response.raise_for_status()
            parsed = parse_quotes(response.content, market)
            if not parsed:
                # 마지막 페이지를 넘어서면 표가 비어서 돌아온다.
                break
            for quote in parsed:
                if quote.stock_code in seen:
                    continue
                seen.add(quote.stock_code)
                quotes.append(quote)
            time.sleep(sleep)

    return quotes


def parse_quotes(payload: bytes, market: str) -> list[NaverQuote]:
    """EUC-KR HTML 을 파싱한다. 네트워크와 분리해 테스트 가능하게 둔다."""
    html = payload.decode("euc-kr", errors="replace")

    quotes: list[NaverQuote] = []
    for row in _ROW.findall(html):
        matched = _CODE.search(row)
        if not matched:
            continue
        stock_code, name = matched.group(1), _clean(matched.group(2))

        cells = [_clean(c) for c in _CELL.findall(row)]
        if len(cells) < _MIN_CELLS:
            continue

        price = _to_int(cells[_PRICE])
        cap_eok = _to_int(cells[_MARKET_CAP])
        shares_k = _to_int(cells[_SHARES])
        if price is None or cap_eok is None or shares_k is None:
            continue

        market_cap = cap_eok * 100_000_000
        shares = shares_k * 1_000

        # 자리 밀림을 잡는 검산. 시총 = 종가 × 주식수 여야 한다.
        # 네이버가 억원 단위에서 반올림하므로 1% 오차를 허용한다.
        # 컬럼이 하나라도 밀리면 여기서 수십 배가 어긋나 전부 걸린다.
        expected = price * shares
        if expected == 0 or abs(market_cap - expected) / expected > 0.01:
            continue

        quotes.append(
            NaverQuote(
                stock_code=stock_code,
                company_name=name,
                market=market,
                market_cap=market_cap,
                shares_outstanding=shares,
                close_price=price,
            )
        )
    return quotes


def _clean(cell: str) -> str:
    text = _TAG.sub("", cell)
    for entity, char in (("&amp;", "&"), ("&nbsp;", " "), ("&lt;", "<"), ("&gt;", ">")):
        text = text.replace(entity, char)
    return " ".join(text.split())


def _to_int(value: str) -> int | None:
    digits = value.replace(",", "").strip()
    if not digits or not digits.lstrip("-").isdigit():
        return None
    return int(digits)
