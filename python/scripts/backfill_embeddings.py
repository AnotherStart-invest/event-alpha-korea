"""Phase 5-3. company_exposures 임베딩 백필.

    python -m python.scripts.backfill_embeddings [--limit 500]

용량 주의(RISK 2.4): 1536차원 x 4byte ~= 6KB/행이다.
Supabase 무료 티어 500MB 를 지키기 위해 검색에 실제로 쓰이는 타입만 임베딩한다.
"""
from __future__ import annotations

import argparse

from ..common.config import force_utf8_stdout
from ..common.db import chunked, get_client
from ..common.llm import embed
from ..common.log import Logger

log = Logger("backfill_embeddings")

# 후보 검색에서 실제로 쓰이는 타입만. 나머지는 임베딩하지 않는다.
EMBEDDABLE = ["product", "raw_material", "commodity", "customer_industry", "customer"]

BATCH = 100


def main() -> None:
    force_utf8_stdout()
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=500)
    args = parser.parse_args()

    supabase = get_client()
    rows = (
        supabase.table("company_exposures")
        .select("id, exposure_value, exposure_type")
        .in_("exposure_type", EMBEDDABLE)
        .is_("embedding", "null")
        .limit(args.limit)
        .execute()
        .data
        or []
    )

    if not rows:
        print("임베딩할 노출이 없습니다.")
        return

    log.info("임베딩 시작", count=len(rows))
    done = 0

    for batch in chunked(rows, BATCH):
        vectors = embed([r["exposure_value"] for r in batch])
        for row, vector in zip(batch, vectors, strict=True):
            supabase.table("company_exposures").update({"embedding": vector}).eq("id", row["id"]).execute()
        done += len(batch)
        log.info("진행", done=done, total=len(rows))

    print(f"\n{done}건의 임베딩을 저장했습니다.")


if __name__ == "__main__":
    main()
