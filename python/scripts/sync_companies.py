"""Phase 5-1. 국내 상장사 기업 마스터를 적재한다.

    python -m python.scripts.sync_companies [--limit N] [--no-cache]

멱등하다. corp_code 충돌 시 갱신하므로 몇 번을 돌려도 행이 늘지 않는다.
"""
from __future__ import annotations

import argparse

from ..common.config import force_utf8_stdout
from ..common.db import chunked, get_client, normalize_term
from ..common.log import Logger
from ..dart.client import fetch_corp_codes, iter_listed

log = Logger("sync_companies")

# OpenDART corp_cls → market_type
MARKET_BY_CLS = {"Y": "KOSPI", "K": "KOSDAQ", "N": "KONEX"}


def main() -> None:
    force_utf8_stdout()
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=0, help="상위 N개만 (0=전체)")
    parser.add_argument("--no-cache", action="store_true")
    args = parser.parse_args()

    entries = list(iter_listed(fetch_corp_codes(use_cache=not args.no_cache)))
    if args.limit:
        entries = entries[: args.limit]

    log.info("상장사 적재 시작", count=len(entries))
    supabase = get_client()

    rows = [
        {
            "corp_code": entry.corp_code,
            "stock_code": entry.stock_code,
            "company_name": entry.corp_name,
            "search_text": f"{entry.corp_name} {normalize_term(entry.corp_name)}",
        }
        for entry in entries
    ]

    inserted = 0
    for batch in chunked(rows, 500):
        supabase.table("companies").upsert(batch, on_conflict="corp_code").execute()
        inserted += len(batch)
        log.info("적재 진행", done=inserted, total=len(rows))

    log.info("완료", companies=inserted)
    print(f"\n상장사 {inserted}건을 적재했습니다.")
    print("다음: python -m python.scripts.build_profiles --limit 50")


if __name__ == "__main__":
    main()
