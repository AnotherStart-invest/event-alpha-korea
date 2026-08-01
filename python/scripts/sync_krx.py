"""KRX 상장법인목록으로 기업 마스터를 보강한다. **LLM 토큰을 한 개도 쓰지 않는다.**

    python -m python.scripts.sync_krx [--dry-run] [--no-exposures]

하는 일:
  1. 시장구분·업종·주요제품을 companies 에 채운다 (지금까지 전부 null 이었다)
  2. KRX 에 없는 종목을 is_listed=false 로 내린다 — DART corpCode.xml 에 섞여 있는
     상장폐지 껍데기(한빛네트·엔플렉스 등)가 검색과 언급 매칭에서 사라진다
  3. 주요제품을 쪼개 company_exposures(product) 로 적재한다

3번이 핵심이다. 후보 생성(lib/matching/candidates.ts)은 company_exposures 만 뒤지는데,
그걸 채우는 build_profiles 는 기업당 LLM 5회를 쓴다. 무료 티어 하루 20회로는
하루 4개 기업이 한계라 사실상 채울 수 없었다. KRX 주요제품은 품질이 낮은 대신
전 종목분이 공짜다. 품질 높은 사업보고서 프로필은 그 위에 덧씌우면 된다.

멱등하다. 몇 번을 돌려도 행이 늘지 않는다.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone

from ..common.config import force_utf8_stdout
from ..common.db import chunked, get_client, normalize_term
from ..common.log import Logger
from ..krx.client import KrxListing, LIST_URL, fetch_listings, split_products

log = Logger("sync_krx")

PAGE = 1000
BATCH = 500
EVIDENCE_TITLE = "KRX 상장법인목록 — 주요제품"


def main() -> None:
    force_utf8_stdout()
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true", help="쓰지 않고 집계만 출력")
    parser.add_argument("--no-exposures", action="store_true", help="주요제품 적재를 건너뛴다")
    args = parser.parse_args()

    started_at = datetime.now(timezone.utc).isoformat()

    listings = fetch_listings()
    log.info("KRX 상장목록 수신", count=len(listings))
    if not listings:
        raise SystemExit("상장목록이 비어 있습니다. KIND 응답 형식이 바뀌었는지 확인하세요.")

    products_total = sum(len(split_products(l.main_products)) for l in listings)
    if args.dry_run:
        by_market: dict[str, int] = {}
        for listing in listings:
            by_market[listing.market or "미상"] = by_market.get(listing.market or "미상", 0) + 1
        print(f"\n[dry-run] 상장사 {len(listings)}건 / 시장별 {by_market}")
        print(f"[dry-run] 주요제품 항목 {products_total}건")
        for listing in listings[:5]:
            print(f"  {listing.stock_code} {listing.company_name}: {split_products(listing.main_products)}")
        return

    supabase = get_client()

    # ── 1. 기업 마스터 갱신 ────────────────────────────────────
    rows = [
        {
            "stock_code": l.stock_code,
            "company_name": l.company_name,
            "market": l.market,
            "industry_name": l.industry_name,
            "main_products": l.main_products,
            "is_listed": True,
            "krx_synced_at": started_at,
            "search_text": f"{l.company_name} {normalize_term(l.company_name)} {l.main_products or ''}",
        }
        for l in listings
    ]
    for batch in chunked(rows, BATCH):
        supabase.table("companies").upsert(batch, on_conflict="stock_code").execute()
    log.info("기업 마스터 갱신", updated=len(rows))

    # ── 2. 상장폐지 종목 내리기 ────────────────────────────────
    # 이번 실행에서 손대지 않은 행 = KRX 목록에 없는 종목.
    delisted = 0
    for query in (
        supabase.table("companies").update({"is_listed": False}).is_("krx_synced_at", "null"),
        supabase.table("companies").update({"is_listed": False}).lt("krx_synced_at", started_at),
    ):
        result = query.eq("is_listed", True).execute()
        delisted += len(result.data or [])
    log.info("상장폐지 종목 내림", count=delisted)

    if args.no_exposures:
        _report(len(rows), delisted, 0, 0)
        return

    # ── 3. 주요제품 → company_exposures ────────────────────────
    company_ids = _load_company_ids(supabase)
    evidence_ids = _ensure_evidence(supabase, listings, company_ids)

    exposures: list[dict] = []
    for listing in listings:
        company_id = company_ids.get(listing.stock_code)
        if not company_id:
            continue
        for term in split_products(listing.main_products):
            normalized = normalize_term(term)
            if len(normalized) < 2:
                continue
            exposures.append(
                {
                    "company_id": company_id,
                    "exposure_type": "product",
                    "exposure_value": term,
                    "normalized_value": normalized,
                    # 거래소 공시 원문이지만 사업보고서로 대조한 것은 아니다.
                    "verified": False,
                    "source_evidence_id": evidence_ids.get(company_id),
                }
            )

    # 같은 기업이 같은 제품명을 두 번 낼 수 있다(괄호 안팎). 배치 안에서 미리 접는다.
    deduped = {(e["company_id"], e["exposure_type"], e["normalized_value"]): e for e in exposures}
    payload = list(deduped.values())

    # 옛 항목을 먼저 지운다. **upsert 만 하면 파싱 규칙을 고쳐도 옛 결과가 남는다.**
    # 실측: split_products 가 "기타 전자부품 제조업" 을 "전자부품" 으로 바꾸도록 고쳐도
    # 옛 행이 그대로 살아 있어 LG이노텍이 계속 업종명으로 매칭됐다.
    # KRX 유래 행만 지운다 — 사업보고서(build_profiles)로 만든 것은 근거가 달라 건드리지 않는다.
    removed = _clear_krx_products(supabase, list(evidence_ids.values()))
    log.info("옛 주요제품 삭제", removed=removed)

    for batch in chunked(payload, BATCH):
        supabase.table("company_exposures").upsert(
            batch, on_conflict="company_id,exposure_type,normalized_value"
        ).execute()
    log.info("주요제품 적재", exposures=len(payload))

    _report(len(rows), delisted, len(evidence_ids), len(payload))


def _clear_krx_products(supabase, evidence_ids: list[str]) -> int:
    """KRX 주요제품에서 만든 product 노출을 지운다.

    근거(source_evidence_id)로 식별한다 — 이 값이 KRX 목록 evidence 를 가리키면
    이 스크립트가 만든 행이다. 사업보고서 유래 노출은 다른 evidence 를 갖고 있어
    걸리지 않는다.

    URL 길이 제한이 있어 id 를 나눠 보낸다.
    """
    removed = 0
    for batch in chunked([e for e in evidence_ids if e], 100):
        result = (
            supabase.table("company_exposures")
            .delete()
            .eq("exposure_type", "product")
            .in_("source_evidence_id", batch)
            .execute()
        )
        removed += len(result.data or [])
    return removed


def _load_company_ids(supabase) -> dict[str, str]:
    """stock_code → id. 3,900여 건이라 PostgREST 기본 1,000행 상한을 넘는다."""
    mapping: dict[str, str] = {}
    offset = 0
    while True:
        result = (
            supabase.table("companies")
            .select("id, stock_code")
            .not_.is_("stock_code", "null")
            .range(offset, offset + PAGE - 1)
            .execute()
        )
        chunk = result.data or []
        for row in chunk:
            mapping[row["stock_code"]] = row["id"]
        if len(chunk) < PAGE:
            return mapping
        offset += PAGE


def _ensure_evidence(supabase, listings: list[KrxListing], company_ids: dict[str, str]) -> dict[str, str]:
    """기업당 KRX 근거 1건. 이미 있으면 재사용한다(재실행해도 안 늘어나게)."""
    existing: dict[str, str] = {}
    offset = 0
    while True:
        result = (
            supabase.table("evidence_sources")
            .select("id, company_id")
            .eq("source_type", "exchange")
            .eq("source_title", EVIDENCE_TITLE)
            .range(offset, offset + PAGE - 1)
            .execute()
        )
        chunk = result.data or []
        for row in chunk:
            if row["company_id"]:
                existing[row["company_id"]] = row["id"]
        if len(chunk) < PAGE:
            break
        offset += PAGE

    today = datetime.now(timezone.utc).date().isoformat()
    missing = []
    for listing in listings:
        company_id = company_ids.get(listing.stock_code)
        if not company_id or company_id in existing or not listing.main_products:
            continue
        missing.append(
            {
                "company_id": company_id,
                "source_type": "exchange",
                "source_title": EVIDENCE_TITLE,
                "source_url": LIST_URL,
                "source_date": today,
                # excerpt 는 500자 제약이 걸려 있다.
                "excerpt": listing.main_products[:500],
            }
        )

    for batch in chunked(missing, BATCH):
        result = supabase.table("evidence_sources").insert(batch).execute()
        for row in result.data or []:
            existing[row["company_id"]] = row["id"]
    log.info("근거 준비", reused=len(existing) - len(missing), created=len(missing))
    return existing


def _report(updated: int, delisted: int, evidence: int, exposures: int) -> None:
    print(f"\n상장사 {updated}건 갱신 / 상장폐지 {delisted}건 내림")
    print(f"근거 {evidence}건 / 주요제품 노출 {exposures}건")
    print("\n다음: npm run dev 후 /api/cron/mentions 호출로 기사 언급 매칭 실행")


if __name__ == "__main__":
    main()
