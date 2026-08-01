import type { RelationType } from '@/lib/db/enums';
import type { Candidate, EventQuery, MatchedExposure, ScoreBreakdown, ScoredCandidate } from './types';

/**
 * 관련도 점수 계산 (ARCHITECTURE §7.2). 100점 만점.
 *
 * 부수효과 없는 순수 함수다. 제품 품질이 여기 달려 있으므로
 * 모든 항목에 단위 테스트가 있어야 한다.
 *
 *   직접 제품 관련성  20
 *   사업 집중도       20   ← 0009
 *   실제 매출·수주    15
 *   공식 공시 근거    15
 *   고객·공급망       10
 *   지역 노출         10
 *   업종 적합          5   ← 0009
 *   최근성             5
 *                    ─────
 *                     100
 *
 *   단순 테마          5   ← 위 8개 합이 0일 때만 부여. 배타적이라 100 에 안 들어간다.
 *
 * 집중도·업종을 왜 넣었나 (0009):
 *   이 둘이 없을 때 한 이벤트의 종목 10개가 **전부 35점 동점**이었다. KRX 주요제품에
 *   검색어가 적혀 있기만 하면 그게 유일한 사업이든 12개 중 하나든 똑같이 25점을
 *   받았기 때문이다. 그래서 "소프트웨어 개발"만 하는 라온시큐어와, 원양어업·참치통조림
 *   사이에 소프트웨어가 끼어 있는 사조산업이 같은 줄에 섰다.
 *   점수는 "얼마나 관련 있나"를 재야지 "관련 단어가 있나"를 재면 안 된다.
 *
 *   자리를 만들려고 product 25→20, revenue 20→15, geography·supplyChain 15→10 으로
 *   낮췄다. 특히 product 를 깎은 것은 의도적이다 — "주요제품에 그 단어가 있다"는
 *   가장 약한 신호인데 가장 높은 배점을 갖고 있었다.
 */

/** 실근거 항목. 합이 정확히 100 이어야 한다. */
export const EVIDENCE_MAX_SCORES = {
  product: 20,
  focus: 20,
  revenue: 15,
  disclosure: 15,
  supplyChain: 10,
  geography: 10,
  industry: 5,
  recency: 5,
} as const;

/**
 * 테마 점수는 실근거가 하나도 없을 때만 붙는다. 다른 항목과 **배타적**이므로
 * 100점 합계에 들어가지 않는다 — 넣으면 도달 불가능한 만점이 생긴다.
 */
export const THEMATIC_SCORE = 5;

export const MAX_SCORES = {
  ...EVIDENCE_MAX_SCORES,
  thematic: THEMATIC_SCORE,
} as const;

/** 이 점수 미만은 공개 화면에서 제외한다 (R4) */
export const PUBLIC_SCORE_FLOOR = 20;
/** thematic 강등 시 점수 상한 (R2) */
export const THEMATIC_SCORE_CAP = 39;

const PRODUCT_TYPES = new Set(['product', 'raw_material', 'commodity']);
const SUPPLY_TYPES = new Set(['customer', 'customer_industry', 'supplier', 'competitor', 'substitute']);

/**
 * 용어 변별력 가중치 — 그 용어를 가진 기업이 많을수록 매칭의 의미가 옅다.
 *
 * 실측(제품 노출 7,100건 / 고유 용어 5,348개):
 *   1개사  4,615개 용어(86%)  "폐배터리 리사이클" — 종목을 특정한다
 *   2~3개사  571개
 *   4~10개사 143개
 *   11개사+   19개            "반도체" 26 · "지주회사" 33 · "부동산 임대" 54 — 아무도 특정 못 한다
 *
 * 이 가중치가 없을 때 둘이 **같은 점수**를 받았다. "단어가 겹친다"를 "관련이 있다"로
 * 셈한 것이고, 화면에 관련 없는 종목이 깔린 직접적인 원인이다.
 */
export function specificityWeight(termCompanyCount: number): number {
  if (termCompanyCount <= 1) return 1;
  if (termCompanyCount <= 3) return 0.8;
  if (termCompanyCount <= 10) return 0.5;
  return 0.25;
}

/**
 * 이 수를 넘는 기업이 가진 용어는 **그것만으로는** 근거가 되지 못한다.
 * 업종까지 맞아야 후보로 남긴다 (applyHardRules 의 R6).
 */
export const GENERIC_TERM_COMPANIES = 3;

/* ── 항목별 계산 ───────────────────────────────────────── */

export function scoreProduct(exposures: MatchedExposure[]): { score: number; note?: string } {
  const relevant = exposures.filter((e) => PRODUCT_TYPES.has(e.exposureType));
  if (relevant.length === 0) return { score: 0 };

  let best = 0;
  let note: string | undefined;

  for (const exposure of relevant) {
    let value = 0;
    switch (exposure.matchKind) {
      case 'exact':
        value = 20;
        break;
      case 'synonym':
        value = 16;
        break;
      case 'fulltext':
        value = 10;
        break;
      case 'embedding': {
        const sim = exposure.similarity ?? 0;
        if (sim >= 0.85) value = 12;
        else if (sim >= 0.75) value = 6;
        else value = 0;
        break;
      }
      case 'relation':
        value = 0;
        break;
    }
    // 변별력으로 깎는다. "반도체"(26개사) 정확 일치는 20점이 아니라 5점이다.
    const weighted = value * specificityWeight(exposure.termCompanyCount);
    if (weighted > best) {
      best = weighted;
      const shared =
        exposure.termCompanyCount > 1 ? ` · 같은 용어 보유 ${exposure.termCompanyCount}개사` : '';
      note = `제품 매칭: ${exposure.exposureValue} (${exposure.matchKind})${shared}`;
    }
  }
  return { score: Math.round(best), note };
}

export function scoreRevenue(exposures: MatchedExposure[]): { score: number; note?: string } {
  if (exposures.length === 0) return { score: 0 };

  const shares = exposures
    .map((e) => e.revenueShare)
    .filter((s): s is number => s !== null && s > 0);

  if (shares.length > 0) {
    const max = Math.max(...shares);
    if (max >= 30) return { score: 15, note: `매출 비중 ${max}%` };
    if (max >= 10) return { score: 11, note: `매출 비중 ${max}%` };
    return { score: 6, note: `매출 비중 ${max}%` };
  }

  // 수치는 없지만 근거 문서가 붙어 있는 경우
  if (exposures.some((e) => e.evidenceId !== null)) {
    return { score: 4, note: '근거는 있으나 매출 비중 수치 미상' };
  }
  return { score: 0 };
}

export function scoreGeography(
  exposures: MatchedExposure[],
  eventGeography: string[],
): { score: number; note?: string } {
  if (eventGeography.length === 0) return { score: 0 };
  const wanted = new Set(eventGeography.map(normalize));

  let best = 0;
  let note: string | undefined;

  for (const exposure of exposures) {
    const values = [exposure.geography, exposure.exposureType === 'geography' ? exposure.exposureValue : null]
      .filter((v): v is string => Boolean(v))
      .map(normalize);
    if (values.length === 0) continue;

    for (const value of values) {
      let candidateScore = 0;
      if (wanted.has(value)) {
        // 매출 지역인지 생산 지역인지는 revenue_share 유무로 근사한다.
        candidateScore = exposure.revenueShare !== null ? 10 : 7;
      } else if ([...wanted].some((w) => w.includes(value) || value.includes(w))) {
        candidateScore = 5;
      }
      if (candidateScore > best) {
        best = candidateScore;
        note = `지역 노출: ${exposure.geography ?? exposure.exposureValue}`;
      }
    }
  }
  return { score: best, note };
}

export function scoreSupplyChain(exposures: MatchedExposure[]): { score: number; note?: string } {
  let best = 0;
  let note: string | undefined;

  for (const exposure of exposures) {
    if (!SUPPLY_TYPES.has(exposure.exposureType)) continue;
    let value = 0;
    switch (exposure.exposureType) {
      case 'customer':
        value = 10;
        break;
      case 'customer_industry':
      case 'supplier':
        value = 7;
        break;
      case 'competitor':
      case 'substitute':
        value = 5;
        break;
    }
    if (value > best) {
      best = value;
      note = `공급망 관계: ${exposure.exposureType} = ${exposure.exposureValue}`;
    }
  }
  return { score: best, note };
}

export function scoreDisclosure(exposures: MatchedExposure[]): { score: number; note?: string } {
  let best = 0;
  let note: string | undefined;

  for (const exposure of exposures) {
    let value = 0;
    if (exposure.evidenceSourceType === 'dart') {
      value = exposure.evidenceVerified ? 15 : 10;
    } else if (exposure.evidenceSourceType !== null) {
      value = 5;
    }
    if (value > best) {
      best = value;
      note = exposure.evidenceSourceType === 'dart' ? '공시 근거 확인' : '뉴스 등 비공시 근거';
    }
  }
  return { score: best, note };
}

/**
 * 사업 집중도 — 매칭된 제품이 그 회사의 사업에서 차지하는 비중.
 *
 * 분모는 회사가 파는 제품의 총 가짓수(companies.product_exposure_count),
 * 분자는 그중 이번 이벤트로 걸린 개수다.
 *
 * 실측 (유학생 비자 이벤트, 전부 "소프트웨어 개발" 하나로 걸림):
 *   라온시큐어 1/1 → 20점    사업이 그것뿐이라 사건이 곧 실적이다
 *   비상교육   1/2 → 12점
 *   SK         1/8 →  3점
 *   사조산업   1/12 →  2점   원양어업 회사가 소프트웨어 한 줄로 걸린 것
 *
 * 분모가 0 이면(제품 노출을 아직 안 쌓은 기업) 0점이다. 추정으로 점수를 주면
 * 데이터가 없는 기업이 유리해지는 역전이 생긴다.
 */
export function scoreFocus(
  exposures: MatchedExposure[],
  productExposureCount: number,
): { score: number; note?: string } {
  if (productExposureCount <= 0) return { score: 0 };

  const matched = exposures.filter((e) => PRODUCT_TYPES.has(e.exposureType)).length;
  if (matched === 0) return { score: 0 };

  const ratio = Math.min(matched / productExposureCount, 1);
  const score = Math.round(ratio * MAX_SCORES.focus);
  return {
    score,
    note: `사업 집중도: 제품 ${productExposureCount}개 중 ${Math.min(matched, productExposureCount)}개 관련`,
  };
}

/**
 * 업종 적합 — 회사의 업종명이 이벤트가 건드리는 산업과 맞는가.
 *
 * 집중도만으로는 "한 가지만 파는 작은 회사"가 무조건 유리해진다. 업종이
 * 이벤트와 무관하면 그 집중도는 의미가 없으므로 한 축을 더 둔다.
 * KRX 업종명은 "소프트웨어 개발 및 공급업" 처럼 서술형이라 부분 포함으로 본다.
 */
export function scoreIndustry(
  industryName: string | null,
  eventIndustries: string[],
): { score: number; note?: string } {
  if (!industryName || eventIndustries.length === 0) return { score: 0 };

  const industry = normalize(industryName);
  for (const term of eventIndustries) {
    const wanted = normalize(term);
    if (wanted.length < 2) continue;
    if (industry.includes(wanted) || wanted.includes(industry)) {
      return { score: MAX_SCORES.industry, note: `업종 일치: ${industryName}` };
    }
  }
  return { score: 0 };
}

export function scoreRecency(
  latestReportDate: string | null,
  now = new Date(),
): { score: number; note?: string } {
  if (!latestReportDate) return { score: 0 };
  const months =
    (now.getTime() - new Date(latestReportDate).getTime()) / (1000 * 60 * 60 * 24 * 30.44);
  if (months < 0) return { score: 5, note: '최신 보고서' };
  if (months <= 6) return { score: 5, note: '6개월 내 보고서' };
  if (months <= 12) return { score: 3, note: '1년 내 보고서' };
  if (months <= 24) return { score: 1, note: '2년 내 보고서' };
  return { score: 0, note: '보고서가 2년 이상 지남' };
}

/* ── 통합 ─────────────────────────────────────────────── */

export function scoreCandidate(
  candidate: Candidate,
  query: EventQuery,
  now = new Date(),
): ScoreBreakdown {
  const notes: string[] = [];
  const push = (r: { score: number; note?: string }) => {
    if (r.note) notes.push(r.note);
    return r.score;
  };

  const product = push(scoreProduct(candidate.exposures));
  const revenue = push(scoreRevenue(candidate.exposures));
  const focus = push(scoreFocus(candidate.exposures, candidate.productExposureCount));
  const geography = push(scoreGeography(candidate.exposures, query.geography));
  const supplyChain = push(scoreSupplyChain(candidate.exposures));
  const disclosure = push(scoreDisclosure(candidate.exposures));
  const industry = push(scoreIndustry(candidate.industryName, query.industries));
  const recency = push(scoreRecency(candidate.latestReportDate, now));

  const evidenceSum =
    product + revenue + focus + geography + supplyChain + disclosure + industry + recency;

  // 테마 점수는 실근거 점수가 전혀 없을 때만 부여한다.
  // 그러지 않으면 키워드 하나로 실근거 종목의 순위를 밀어올리게 된다.
  const thematic = evidenceSum === 0 && candidate.exposures.length > 0 ? THEMATIC_SCORE : 0;
  if (thematic > 0) notes.push('키워드/산업분류상 관련만 확인됨');

  const total = Math.min(evidenceSum + thematic, 100);

  return {
    product,
    revenue,
    focus,
    geography,
    supplyChain,
    disclosure,
    industry,
    recency,
    thematic,
    total,
    notes,
  };
}

/**
 * 하드 룰 (ARCHITECTURE §7.2 R1~R5).
 * 점수와 독립적으로 적용되며, LLM 판정을 덮어쓴다.
 */
export function applyHardRules(
  candidate: Candidate,
  breakdown: ScoreBreakdown,
  llmRelationType: RelationType,
  evidenceIdCount: number,
): { relationType: RelationType; score: number; excluded: boolean; reason?: string } {
  // R1: 종목코드 없는 기업은 제외
  if (!candidate.stockCode) {
    return { relationType: llmRelationType, score: 0, excluded: true, reason: 'no_stock_code' };
  }

  // R6: 흔한 용어 하나로만 걸렸고 업종도 안 맞으면 제외한다.
  //
  // "반도체"(26개사) · "지주회사"(33개사) 같은 용어는 그 자체로 아무 회사도 특정하지
  // 못한다. 그런 매칭만 있는데 업종마저 무관하면 남길 근거가 없다 — 이게 원양어업
  // 회사가 소프트웨어 뉴스에, 지주사가 아무 뉴스에나 붙던 경로다.
  //
  // **점수를 깎는 것으로는 부족하다.** 낮은 점수라도 화면에 남으면 읽는 사람이
  // 하나씩 걸러내야 하고, 그 순간 목록은 신뢰를 잃는다.
  if (isGenericOnly(candidate) && (breakdown.industry ?? 0) === 0) {
    return { relationType: 'thematic', score: 0, excluded: true, reason: 'generic_term_only' };
  }

  let relationType = llmRelationType;
  let reason: string | undefined;

  // R3: 근거 링크가 하나도 없으면 thematic
  if (evidenceIdCount === 0) {
    relationType = 'thematic';
    reason = 'no_evidence';
  }

  // R2: 공시 근거도 매출 근거도 없으면 thematic + 39점 캡
  if (breakdown.disclosure === 0 && breakdown.revenue === 0) {
    relationType = 'thematic';
    reason = reason ?? 'no_disclosure_no_revenue';
  }

  const score = relationType === 'thematic' ? Math.min(breakdown.total, THEMATIC_SCORE_CAP) : breakdown.total;

  return { relationType, score, excluded: false, reason };
}

/**
 * 걸린 근거가 **전부** 흔한 용어인가.
 *
 * 하나라도 변별력 있는 용어(GENERIC_TERM_COMPANIES 이하)로 걸렸다면 통과다 —
 * "반도체"로도 걸리고 "메모리 테스트 소켓"으로도 걸린 기업은 후자가 근거다.
 * 매출·공시 근거가 따로 있으면 용어가 흔해도 남긴다.
 */
function isGenericOnly(candidate: Candidate): boolean {
  const products = candidate.exposures.filter((e) => PRODUCT_TYPES.has(e.exposureType));
  if (products.length === 0) return false;
  return products.every((e) => e.termCompanyCount > GENERIC_TERM_COMPANIES);
}

/** 후보를 점수 순으로 정렬한다. 종목코드 없는 기업은 이 단계에서 버린다. */
export function rankCandidates(
  candidates: Candidate[],
  query: EventQuery,
  now = new Date(),
): ScoredCandidate[] {
  return candidates
    .filter((c) => c.stockCode !== null)
    .map((candidate) => {
      const breakdown = scoreCandidate(candidate, query, now);
      const forcedRelationType: RelationType | null =
        breakdown.disclosure === 0 && breakdown.revenue === 0 ? 'thematic' : null;
      return { candidate, breakdown, forcedRelationType };
    })
    .sort((a, b) => b.breakdown.total - a.breakdown.total);
}

/** 화면 표시용 관련도 등급 (PRODUCT_SPEC §7) */
export function relevanceLabel(score: number): string {
  if (score >= 90) return '직접적인 실적 영향 근거가 강함';
  if (score >= 75) return '직접 사업 관련성이 확인됨';
  if (score >= 60) return '공급망 또는 고객 관계가 확인됨';
  if (score >= 40) return '간접 영향 또는 추가 확인 필요';
  if (score >= 20) return '단순 테마 가능성';
  return '기본 화면에서 제외';
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, '');
}
