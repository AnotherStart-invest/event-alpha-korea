"""전 종목 시가총액을 companies 에 채운다. **LLM 토큰을 한 개도 쓰지 않는다.**

    python -m python.scripts.sync_market_cap [--dry-run]

왜 필요한가:
  관련도 점수가 종목을 변별하지 못한다. 실측으로 한 이벤트의 종목 10개가 전부
  35점 동점이었다(제품 25 + 매출근거 5 + 공시 5). KRX 주요제품 문자열이 정확히
  일치하기만 하면 무조건 이 점수라, SK 와 사조산업이 같은 줄에 선다.
  시가총액이 지금 유일하게 작동하는 정렬 축이다.

멱등하다. 몇 번을 돌려도 행이 늘지 않는다. 매일 장 마감 후 한 번이면 충분하다.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone

from ..common.config import force_utf8_stdout
from ..common.db import chunked, get_client
from ..common.log import Logger
from ..naver.market_cap import LIST_URL, fetch_quotes

log = Logger("sync_market_cap")

BATCH = 500
PAGE = 1000

# 규모 구간. 화면 배지(lib/shared/format.ts 의 marketCapTier)와 **반드시 같은 경계**다.
LARGE = 1_000_000_000_000  # 1조
MID = 300_000_000_000  # 3천억


def main() -> None:
    force_utf8_stdout()
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true", help="쓰지 않고 집계만 출력")
    args = parser.parse_args()

    quotes = fetch_quotes()
    log.info("네이버 시총 수신", count=len(quotes))
    if not quotes:
        raise SystemExit(f"시총 목록이 비어 있습니다. {LIST_URL} 응답 형식이 바뀌었는지 확인하세요.")

    if args.dry_run:
        _report(quotes)
        return

    supabase = get_client()
    now = datetime.now(timezone.utc).isoformat()

    # companies 에 있는 종목만 갱신한다. 그러지 않으면 우선주·리츠 등 우리가
    # 추적하지 않는 종목이 껍데기 행으로 들어온다.
    known = _load_known_names(supabase)
    targets = [q for q in quotes if q.stock_code in known]
    log.info("대상 종목", matched=len(targets), skipped=len(quotes) - len(targets))

    updated = 0
    for batch in chunked(targets, BATCH):
        supabase.table("companies").upsert(
            [
                {
                    "stock_code": q.stock_code,
                    # company_name 을 반드시 같이 보내야 한다. upsert 는 INSERT .. ON CONFLICT
                    # 인데, NOT NULL 은 충돌 판정보다 **먼저** 검사되므로 이름을 빼면
                    # "null value in column company_name" 으로 죽는다.
                    #
                    # 네이버 표기가 아니라 **우리 DB 의 이름을 그대로 되돌려 보낸다.**
                    # 네이버 것을 쓰면 KRX 정본 이름이 조용히 덮어써진다.
                    "company_name": known[q.stock_code],
                    "market_cap": q.market_cap,
                    "shares_outstanding": q.shares_outstanding,
                    "close_price": q.close_price,
                    "price_updated_at": now,
                }
                for q in batch
            ],
            on_conflict="stock_code",
        ).execute()
        updated += len(batch)

    log.info("시총 갱신 완료", updated=updated)
    _report(targets)


def _load_known_names(supabase) -> dict[str, str]:
    """종목코드 → 기업명. 3,900여 건이라 PostgREST 기본 1,000행 상한을 넘는다."""
    names: dict[str, str] = {}
    offset = 0
    while True:
        result = (
            supabase.table("companies")
            .select("stock_code, company_name")
            .not_.is_("stock_code", "null")
            .range(offset, offset + PAGE - 1)
            .execute()
        )
        rows = result.data or []
        for row in rows:
            names[row["stock_code"]] = row["company_name"]
        if len(rows) < PAGE:
            return names
        offset += PAGE


def _report(quotes: list) -> None:
    large = sum(1 for q in quotes if q.market_cap >= LARGE)
    mid = sum(1 for q in quotes if MID <= q.market_cap < LARGE)
    small = len(quotes) - large - mid
    top = sorted(quotes, key=lambda q: q.market_cap, reverse=True)[:5]

    print(f"\n종목 {len(quotes)}건 — 대형 {large} / 중형 {mid} / 소형 {small}")
    for q in top:
        print(f"  {q.stock_code} {q.company_name} {q.market_cap / 1_000_000_000_000:,.1f}조")


if __name__ == "__main__":
    main()
