"""KRX(KIND) 상장법인목록 클라이언트.

OpenDART 의 corpCode.xml 은 **상장폐지 법인까지 포함**하고 시장구분·업종이 없다.
KIND 의 상장법인목록은 그 두 구멍을 무료·무인증으로 메운다.

    회사명 | 시장구분 | 종목코드 | 업종 | 주요제품 | 상장일 | 결산월 | 대표자명 | 홈페이지 | 지역

특히 **주요제품** 컬럼이 중요하다. build_profiles 가 사업보고서에서 LLM 으로 뽑던
제품 정보를, 품질은 낮지만 전 종목분을 토큰 0 으로 얻을 수 있다.

함정:
- 응답은 확장자만 xls 이고 실제로는 **EUC-KR HTML 테이블**이다
- http 는 302 를 준다. https 로 직접 호출해야 한다
- 종목코드가 6자리 숫자가 아닌 행이 섞여 있다(코넥스 신규 등, 예 '0218L0').
  companies.stock_code 의 체크 제약과 충돌하므로 제외한다
"""
from __future__ import annotations

import re
from dataclasses import dataclass

import requests

LIST_URL = "https://kind.krx.co.kr/corpgeneral/corpList.do"
# searchType=13 이 전 시장(유가·코스닥·코넥스)을 한 번에 준다.
PARAMS = {"method": "download", "searchType": "13"}

MARKET_BY_KIND = {"유가": "KOSPI", "코스닥": "KOSDAQ", "코넥스": "KONEX"}

_ROW = re.compile(r"<tr[^>]*>(.*?)</tr>", re.S | re.I)
_CELL = re.compile(r"<t[dh][^>]*>(.*?)</t[dh]>", re.S | re.I)
_TAG = re.compile(r"<[^>]*>")
_STOCK_CODE = re.compile(r"^[0-9]{6}$")


@dataclass(frozen=True)
class KrxListing:
    stock_code: str
    company_name: str
    market: str | None
    industry_name: str | None
    main_products: str | None
    listed_on: str | None


def fetch_listings(timeout: int = 60) -> list[KrxListing]:
    """현재 상장된 전 종목을 가져온다. 약 2,800건."""
    response = requests.get(LIST_URL, params=PARAMS, timeout=timeout)
    response.raise_for_status()
    return parse_listings(response.content)


def parse_listings(payload: bytes) -> list[KrxListing]:
    """EUC-KR HTML 테이블을 파싱한다. 네트워크와 분리해 테스트 가능하게 둔다."""
    html = payload.decode("euc-kr", errors="replace")

    listings: list[KrxListing] = []
    # KIND 응답에는 완전히 같은 행이 두 번 나오는 종목이 42개 있다.
    # 그대로 upsert 하면 "ON CONFLICT DO UPDATE command cannot affect row a second time" 로 죽는다.
    seen: set[str] = set()

    for row in _ROW.findall(html):
        cells = [_clean(c) for c in _CELL.findall(row)]
        if len(cells) < 6:
            continue
        name, market_label, stock_code, industry, products, listed_on = cells[:6]
        if not _STOCK_CODE.match(stock_code):
            # 헤더 행과 코넥스 임시코드가 여기서 걸러진다.
            continue
        if stock_code in seen:
            continue
        seen.add(stock_code)
        listings.append(
            KrxListing(
                stock_code=stock_code,
                company_name=name,
                market=MARKET_BY_KIND.get(market_label),
                industry_name=industry or None,
                main_products=products or None,
                listed_on=listed_on or None,
            )
        )
    return listings


def _clean(cell: str) -> str:
    text = _TAG.sub("", cell)
    for entity, char in (("&amp;", "&"), ("&nbsp;", " "), ("&lt;", "<"), ("&gt;", ">"), ("&quot;", '"')):
        text = text.replace(entity, char)
    return " ".join(text.split())


# ── 주요제품 → 검색 가능한 항목 ────────────────────────────────

# 조각 끝에 붙는 상용어. 제거해야 "스테인리스 제조" 가 "스테인리스" 와 매칭된다.
#
# **산업분류 접미어(…제조업)가 특히 중요하다.** 이게 없을 때 "기타 전자부품 제조업" 이
# 통째로 한 항목이 됐고, 그 표기를 쓰는 회사가 하나뿐이라 "변별력 만점" 을 받아
# LG이노텍이 핵심광물 뉴스에 1등으로 올라왔다. 제품이 아니라 업종명인데도.
# 접미어를 벗기면 "전자부품"(10개사)이 되어 변별력 가중치가 제대로 깎는다.
#
# 순서가 중요하다 — 긴 것을 먼저 둬야 "제조업" 이 "제조" 로 잘못 잘리지 않는다.
_TRAILING = (
    "제조 판매",
    "제조판매",
    "생산 판매",
    "제조업",
    "가공업",
    "처리업",
    "도매업",
    "소매업",
    "판매업",
    "공급업",
    "유통업",
    "운영업",
    "관리업",
    "중개업",
    "알선업",
    "대행업",
    "자문업",
    "임대업",
    "개발업",
    "서비스업",
    "제조",
    "판매",
    "생산",
    "유통",
    "공급",
    "도소매",
    "도매",
    "소매",
    "서비스",
    "사업",
    "등",
    "외",
)
# ⚠️ 여기에 "업" 단독을 넣지 말 것. "원양어업" → "원양어" 처럼 멀쩡한 용어가 망가진다.
# "금융업" · "건설업" 같은 산업명은 보유 기업이 많아 변별력 가중치(scoring.ts)가
# 알아서 깎으므로, 데이터를 훼손하면서까지 접미어를 벗길 이유가 없다.

# 조각 앞에 붙는 군더더기. "기타 전자부품" 의 "기타" 는 아무 정보가 없다.
_LEADING = ("기타 ", "각종 ", "일반 ", "기타")
# 그 자체로는 아무 종목도 특정하지 못하는 값.
# 상용어가 독립 조각으로 나오면(", 도매") _TRAILING 이 못 잡는다 — 접미가 아니라 전체이므로.
_STOPWORDS = {
    "기타",
    "제품",
    "부품",
    "상품",
    "기타제품",
    "각종",
    "일반",
    "종합",
    "기타등",
    "및",
    "제조",
    "제조업",
    "생산",
    "판매",
    "판매업",
    "도매",
    "도매업",
    "소매",
    "도소매",
    "유통",
    "무역",
    "공급",
    "정비",
    "수리",
    "임대",
    "수출",
    "수입",
    "서비스",
    "서비스업",
    "사업",
    "기능",
    "운영",
    "개발",
    "시공",
    "설치",
    # ── 지주사 상용구 ──────────────────────────────────────────
    # 어떤 뉴스와도 인과가 닿지 않는데 지주회사·복합기업이 빠짐없이 적어 둔다.
    # 실측 보유 기업 수: 부동산임대 54 · 지주회사 33 · 수출입 30 · 기업인수합병 27.
    # 매칭되면 그 회사가 "관련 있다" 가 아니라 "지주사다" 라는 뜻일 뿐이다.
    "지주",
    "지주회사",
    "금융지주회사",
    "비금융지주회사",
    "부동산임대",
    "비거주부동산임대",
    "부동산투자",
    "부동산투자회사",
    "부동산",
    "기업인수합병",
    "수출입",
    "금융지원",
    "투자",
    "기업",
    "경영지원",
    "경영자문",
}
_SPLIT = re.compile(r"[,/·;、]|\s및\s|\s+외\s+")
_BRACKET = re.compile(r"[（(]([^）)]*)[）)]")

MAX_PRODUCTS_PER_COMPANY = 12


def split_products(raw: str | None) -> list[str]:
    """KRX 주요제품 문자열을 매칭 가능한 항목들로 쪼갠다.

    "2차전지 (소형,ESS,자동차전지)" → ['2차전지', '소형', 'ESS', '자동차전지']
    "열연코일,냉연강판,후판,선재,스테인리스 제조" → [..., '스테인리스']

    보수적으로 간다. 애매한 조각을 살리는 것보다 버리는 쪽이 오탐 비용이 낮다.
    """
    if not raw:
        return []

    # 괄호 안은 별도 항목으로 떼어낸다. 안 그러면 "2차전지 (소형" 같은 조각이 남는다.
    pieces: list[str] = []
    remainder = _BRACKET.sub(lambda m: _collect(pieces, m.group(1)), raw)
    pieces.append(remainder)

    out: list[str] = []
    seen: set[str] = set()
    for piece in pieces:
        for chunk in _SPLIT.split(piece):
            term = _strip_trailing(chunk)
            if not term:
                continue
            key = term.lower()
            if key in seen:
                continue
            seen.add(key)
            out.append(term)
            if len(out) >= MAX_PRODUCTS_PER_COMPANY:
                return out
    return out


def _stopword_key(term: str) -> str:
    return term.lower().replace(" ", "")


def _collect(bucket: list[str], inner: str) -> str:
    bucket.append(inner)
    return " , "


def _strip_trailing(chunk: str) -> str:
    term = " ".join(chunk.split()).strip("-–—·.'\"")
    # 접미·접두 상용어는 여러 개가 겹쳐 붙는다("기타 전자부품 제조 판매 등").
    # 더 이상 안 줄 때까지 반복한다.
    changed = True
    while changed and term:
        changed = False
        for suffix in _TRAILING:
            if term.endswith(suffix) and len(term) > len(suffix):
                term = term[: -len(suffix)].strip(" ,.")
                changed = True
        for prefix in _LEADING:
            if term.startswith(prefix) and len(term) > len(prefix):
                term = term[len(prefix) :].strip(" ,.")
                changed = True
    if len(term) < 2 or len(term) > 40:
        return ""
    # 띄어쓰기를 무시하고 대조한다 — "부동산 임대" 와 "부동산임대" 는 같은 말이다.
    if _stopword_key(term) in _STOPWORDS:
        return ""
    # 숫자·기호만 남은 조각은 버린다.
    if not re.search(r"[0-9A-Za-z가-힣]{2}", term):
        return ""
    return term
