import type { RelationType } from '@/lib/db/enums';
import type { Candidate, EventQuery, MatchedExposure, ScoreBreakdown, ScoredCandidate } from './types';

/**
 * 관련도 점수 계산 (ARCHITECTURE §7.2). 100점 만점.
 *
 * 부수효과 없는 순수 함수다. 제품 품질이 여기 달려 있으므로
 * 모든 항목에 단위 테스트가 있어야 한다.
 *
 *   직접 제품 관련성  25
 *   실제 매출·수주    20
 *   지역 노출         15
 *   고객·공급망       15
 *   공식 공시 근거    15
 *   최근성             5
 *   단순 테마          5   ← 위 6개 합이 0일 때만 부여
 */

export const MAX_SCORES = {
  product: 25,
  revenue: 20,
  geography: 15,
  supplyChain: 15,
  disclosure: 15,
  recency: 5,
  thematic: 5,
} as const;

/** 이 점수 미만은 공개 화면에서 제외한다 (R4) */
export const PUBLIC_SCORE_FLOOR = 20;
/** thematic 강등 시 점수 상한 (R2) */
export const THEMATIC_SCORE_CAP = 39;

const PRODUCT_TYPES = new Set(['product', 'raw_material', 'commodity']);
const SUPPLY_TYPES = new Set(['customer', 'customer_industry', 'supplier', 'competitor', 'substitute']);

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
        value = 25;
        break;
      case 'synonym':
        value = 20;
        break;
      case 'fulltext':
        value = 12;
        break;
      case 'embedding': {
        const sim = exposure.similarity ?? 0;
        if (sim >= 0.85) value = 15;
        else if (sim >= 0.75) value = 8;
        else value = 0;
        break;
      }
      case 'relation':
        value = 0;
        break;
    }
    if (value > best) {
      best = value;
      note = `제품 매칭: ${exposure.exposureValue} (${exposure.matchKind})`;
    }
  }
  return { score: best, note };
}

export function scoreRevenue(exposures: MatchedExposure[]): { score: number; note?: string } {
  if (exposures.length === 0) return { score: 0 };

  const shares = exposures
    .map((e) => e.revenueShare)
    .filter((s): s is number => s !== null && s > 0);

  if (shares.length > 0) {
    const max = Math.max(...shares);
    if (max >= 30) return { score: 20, note: `매출 비중 ${max}%` };
    if (max >= 10) return { score: 14, note: `매출 비중 ${max}%` };
    return { score: 8, note: `매출 비중 ${max}%` };
  }

  // 수치는 없지만 근거 문서가 붙어 있는 경우
  if (exposures.some((e) => e.evidenceId !== null)) {
    return { score: 5, note: '근거는 있으나 매출 비중 수치 미상' };
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
        candidateScore = exposure.revenueShare !== null ? 15 : 10;
      } else if ([...wanted].some((w) => w.includes(value) || value.includes(w))) {
        candidateScore = 8;
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
        value = 15;
        break;
      case 'customer_industry':
      case 'supplier':
        value = 10;
        break;
      case 'competitor':
      case 'substitute':
        value = 8;
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
  const geography = push(scoreGeography(candidate.exposures, query.geography));
  const supplyChain = push(scoreSupplyChain(candidate.exposures));
  const disclosure = push(scoreDisclosure(candidate.exposures));
  const recency = push(scoreRecency(candidate.latestReportDate, now));

  const evidenceSum = product + revenue + geography + supplyChain + disclosure + recency;

  // 테마 점수는 실근거 점수가 전혀 없을 때만 부여한다.
  // 그러지 않으면 키워드 하나로 실근거 종목의 순위를 밀어올리게 된다.
  const thematic = evidenceSum === 0 && candidate.exposures.length > 0 ? 5 : 0;
  if (thematic > 0) notes.push('키워드/산업분류상 관련만 확인됨');

  const total = Math.min(evidenceSum + thematic, 100);

  return { product, revenue, geography, supplyChain, disclosure, recency, thematic, total, notes };
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
