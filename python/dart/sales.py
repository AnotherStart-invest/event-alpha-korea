"""사업보고서의 「매출 및 수주상황 > 매출실적」 표를 읽어 **품목별 매출 비중**을 뽑는다.

왜 이게 필요한가:
  관련 종목을 고르는 5개 기준 중 "관련 사업의 매출 비중이 확인된다" 를 쓸 수가 없었다.
  `company_exposures.revenue_share` 가 전체 7,100건 중 **4건**뿐이었기 때문이다.
  그래서 "그 회사가 이걸 판다" 까지만 말하고 "그게 그 회사에 얼마나 중요한가" 를
  못 말했고, 그게 종목 선별 품질의 상한이었다.

  이 표에는 품목별 매출액이 숫자로 있다. **LLM 을 쓰지 않는다.**

표 생김새 (포스코퓨처엠 2025 사업보고서 실측):
    부문        | 매출유형 | 품 목            | 2025년 | 2024년 | 2023년
    기초소재사업 | 내화물…  | 내화물 제조…      | 수출 | 20,619 | …
                                              내수 | 484,690 | …
                                              합계 | 505,309 | …
    에너지소재  | …       | 양극재, 음극재     | 수출 | 1,481,822 | …
                                              내수 | 92,261 | …
                                              합계 | 1,574,083 | …
    합 계                                      합계 | 2,938,698 | …

함정:
- **ROWSPAN/COLSPAN 병합이라 행마다 칸 수가 다르다.** 열 인덱스로 읽으면 어긋난다.
  품목은 구간 첫 행에만 나오고, 합계는 2~3행 뒤에 온다. 상태를 들고 걸어야 한다.
- 마지막 "합 계" 블록이 전사 매출이다. 이걸 분모로 쓴다.
- 단위가 백만원/천원/원으로 회사마다 다르다. 표 앞 문구에서 읽는다.
- 회사에 따라 수출/내수 구분이 없고 숫자 한 칸만 있는 경우가 있다.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

# 표 바로 앞의 "(단위 : 백만원)" 문구
_UNIT = re.compile(r"단위\s*[:：]\s*([가-힣]*원)")
_UNIT_SCALE = {"원": 1, "천원": 1_000, "백만원": 1_000_000, "십억원": 1_000_000_000, "억원": 100_000_000}

_TABLE = re.compile(r"<TABLE[^>]*>(.*?)</TABLE>", re.S | re.I)
_ROW = re.compile(r"<TR[^>]*>(.*?)</TR>", re.S | re.I)
_CELL = re.compile(r"<T[DH][^>]*>(.*?)</T[DH]>", re.S | re.I)
_TAG = re.compile(r"<[^>]+>")

# 매출실적 표를 여는 문구. 회사마다 표기가 조금씩 다르다.
_SECTION_HINTS = ("매출실적", "매출 실적")

# 품목이 아니라 표의 구조를 나타내는 칸
_STRUCTURAL = {"수출", "내수", "합계", "합 계", "소계", "소 계", "계", "매출액", "매출유형", "품 목", "품목", "부문", "구분"}

# 이 말이 품목 칸에 있으면 전사 합계 행이다
_GRAND_TOTAL = {"합계", "합 계", "총계", "총 계"}


@dataclass(frozen=True)
class SalesItem:
    """품목 하나의 매출."""

    item: str
    """원 단위 매출액."""
    amount: int
    """전사 매출 대비 비중(%). 소수 둘째 자리."""
    share: float


def parse_sales(document: str) -> list[SalesItem]:
    """사업보고서 원문에서 품목별 매출과 비중을 뽑는다. 못 읽으면 빈 목록."""
    table, unit = _find_sales_table(document)
    if not table:
        return []

    rows = [_cells(r) for r in _ROW.findall(table)]
    rows = [r for r in rows if r]
    if not rows:
        return []

    collected: list[tuple[str, int]] = []
    total: int | None = None
    current: str | None = None

    for cells in rows:
        numbers = [n for n in (_to_int(c) for c in cells) if n is not None]
        texts = [c for c in cells if _to_int(c) is None and c]

        # 머리글 행(숫자 없음)은 통째로 건너뛴다.
        # 여기서 품목을 갱신하면 "2023년 (제53기)연간" 이 품목이 된다.
        if not numbers:
            continue

        # 텍스트 칸이 2개 이상이면 **새 구간이 시작**된 행이다(부문·품목·수출 이 함께 온다).
        # 1개뿐이면 ROWSPAN 으로 이어지는 행(내수/합계)이라 구간 이름을 바꾸지 않는다.
        # 이 구분이 없으면 구간별 "합계" 행이 current 를 덮어써서 전사 합계로 오인된다.
        if len(texts) >= 2:
            picked = _pick_item(texts)
            if picked:
                current = picked
            elif any(t.replace(" ", "") in _GRAND_TOTAL for t in texts):
                # 마지막 "합 계 | 수출" 블록. 여기서부터가 전사 합계다.
                current = "합계"

        if current is None:
            continue

        marker = texts[-1].replace(" ", "") if texts else ""
        if marker in {"수출", "내수"}:
            continue  # 부분값이라 쓰지 않는다

        amount = numbers[0]  # 가장 최근 연도가 첫 숫자다
        if current.replace(" ", "") in _GRAND_TOTAL:
            total = amount
        else:
            collected.append((current, amount))

    if not total:
        # 전사 합계 행이 없으면 품목 합으로 대신한다. 없는 것보다 낫다.
        total = sum(a for _, a in collected)
    if not total:
        return []

    scale = _UNIT_SCALE.get(unit, 1)
    out: list[SalesItem] = []
    seen: set[str] = set()
    for item, amount in collected:
        key = item.replace(" ", "")
        if key in seen:
            continue
        seen.add(key)
        share = round(amount / total * 100, 2)
        if share <= 0 or share > 100:
            continue
        out.append(SalesItem(item=item, amount=amount * scale, share=share))

    # ── 검증 ────────────────────────────────────────────────────
    # 틀린 매출 비중은 없는 것보다 나쁘다. 조금이라도 이상하면 통째로 버린다.
    if not out:
        return []
    total_share = sum(s.share for s in out)
    if not (90 <= total_share <= 110):
        # 부문 합이 전사 매출과 안 맞는다. 내부거래 조정이 있거나 표를 잘못 읽은 것이다.
        # 실측: 삼성전자에서 합 52% 가 나왔다.
        return []
    if len(out) > 20:
        return []

    return sorted(out, key=lambda s: s.share, reverse=True)


def _find_sales_table(document: str) -> tuple[str, str]:
    """매출실적 표와 단위를 찾는다.

    ⚠️ "첫 번째 표를 고른다" 로는 안 된다. 실측으로 두 가지가 걸렸다:
      - 한국타이어: 문구 바로 뒤 표가 **단위만 든 1칸짜리**이고 데이터는 그다음 표다
      - 삼성전자: "…항목을 참고하시기 바랍니다" 같은 **안내 문구**에도 같은 말이 나온다
        (매출실적 이 5회 등장)

    그래서 문구가 나오는 지점마다 뒤따르는 표 몇 개를 훑어 **가장 표다운 것**을 고른다.
    점수는 "숫자가 2개 이상인 행" 수다 — 단위 표나 안내 표는 여기서 0점이 된다.
    """
    # 문서에 나오는 순서대로 훑어 **처음 유효한 표**를 쓴다.
    #
    # ⚠️ "점수가 가장 높은 표" 로 고르면 안 된다. 사업보고서에는 매출실적 표가 여러 개
    # 들어간다(한국타이어 실측 6개) — 본사 다음에 **자회사 표**가 이어진다.
    # 점수로 고르니 자회사 표(제21기, Design 프로토타입·QDM)를 집어서
    # 한국타이어의 매출 비중이라고 내놨다. 보고서는 본사 → 자회사 순이므로 앞선 것이 맞다.
    occurrences: list[int] = []
    for hint in _SECTION_HINTS:
        at = document.find(hint)
        while at >= 0:
            occurrences.append(at)
            at = document.find(hint, at + 1)
    occurrences.sort()

    for at in occurrences:
        window_end = at + 8000
        cursor = at
        for _ in range(4):  # 뒤따르는 표 4개까지만 본다
            start = document.find("<TABLE", cursor)
            if start < 0 or start > window_end:
                break
            end = document.find("</TABLE>", start)
            if end < 0:
                break
            table = document[start : end + 8]
            if _table_score(table) >= 2:
                unit_match = _UNIT.search(document[max(0, at - 400) : start])
                return table, (unit_match.group(1) if unit_match else "원")
            cursor = end + 8

    return "", "원"


def _table_score(table: str) -> int:
    """데이터 표다움. 숫자가 2개 이상인 행의 수. 표준 양식이 아니면 0.

    ⚠️ 숫자 행 수만 세면 엉뚱한 표를 고른다. 실측: 한국타이어에서 R&D 표를 골라
    "Design 프로토타입 44.7%, QDM 39.2%" 를 매출 비중으로 내놨다. 합이 100% 라
    합계 검증도 통과한다 — **틀린 값을 자신 있게 내놓는** 최악의 실패다.

    사업보고서의 매출실적 표에는 「품목」이나 「매출유형」 머리글이 있다.
    그게 없으면 다른 표다.
    """
    header_cells = [c for r in _ROW.findall(table)[:3] for c in _cells(r)]
    header_flat = "".join(header_cells).replace(" ", "")
    if not any(k in header_flat for k in ("품목", "매출유형", "제품")):
        return 0

    score = 0
    for row_html in _ROW.findall(table):
        numeric = sum(1 for c in _cells(row_html) if _to_int(c) is not None)
        if numeric >= 2:
            score += 1
    return score


def _cells(row_html: str) -> list[str]:
    out = []
    for c in _CELL.findall(row_html):
        text = _TAG.sub("", c).replace("&nbsp;", " ").replace("&amp;", "&")
        out.append(" ".join(text.split()))
    return out


def _pick_item(texts: list[str]) -> str | None:
    """구조어가 아닌 가장 마지막 텍스트 칸을 품목으로 본다.

    부문·매출유형이 앞에 오고 품목이 뒤에 오므로 마지막 것이 가장 구체적이다.
    """
    for text in reversed(texts):
        cleaned = text.strip()
        if not cleaned or cleaned.replace(" ", "") in {s.replace(" ", "") for s in _STRUCTURAL}:
            continue
        if len(cleaned) < 2 or len(cleaned) > 80:
            continue
        # 연도 머리글("2025년 (제55기)연간")은 품목이 아니다.
        if re.match(r"^\d{4}\s*년", cleaned):
            continue
        return cleaned
    # 전부 구조어면 호출부가 판단한다(전사 합계 행일 수 있다).
    return None


def _to_int(value: str) -> int | None:
    cleaned = value.replace(",", "").replace(" ", "").strip()
    if not cleaned:
        return None
    negative = cleaned.startswith("(") and cleaned.endswith(")")
    if negative:
        cleaned = cleaned[1:-1]
    cleaned = cleaned.lstrip("-")
    if not cleaned.isdigit():
        return None
    return int(cleaned)
