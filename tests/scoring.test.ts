import { describe, expect, it } from 'vitest';
import {
  MAX_SCORES,
  PUBLIC_SCORE_FLOOR,
  THEMATIC_SCORE_CAP,
  applyHardRules,
  rankCandidates,
  relevanceLabel,
  scoreCandidate,
  scoreDisclosure,
  scoreGeography,
  scoreProduct,
  scoreRecency,
  scoreRevenue,
  scoreSupplyChain,
} from '@/lib/matching/scoring';
import type { Candidate, EventQuery, MatchedExposure } from '@/lib/matching/types';

const NOW = new Date('2026-07-31T00:00:00Z');

function exposure(overrides: Partial<MatchedExposure> = {}): MatchedExposure {
  return {
    id: 'exp-1',
    exposureType: 'product',
    exposureValue: '변압기',
    normalizedValue: '변압기',
    revenueShare: null,
    geography: null,
    direction: null,
    verified: false,
    evidenceId: null,
    evidenceSourceType: null,
    evidenceVerified: false,
    matchKind: 'exact',
    similarity: null,
    matchedKeyword: '변압기',
    ...overrides,
  };
}

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    companyId: 'c-1',
    companyName: '테스트전기',
    stockCode: '000001',
    market: 'KOSPI',
    industryName: '전기장비',
    latestReportDate: '2026-03-15',
    exposures: [exposure()],
    ...overrides,
  };
}

const query: EventQuery = {
  industries: ['전력기기'],
  products: ['변압기'],
  rawMaterials: [],
  customerGroups: [],
  geography: ['미국'],
};

describe('만점 합계', () => {
  it('7개 항목 만점 합은 100이다', () => {
    const sum = Object.values(MAX_SCORES).reduce((a, b) => a + b, 0);
    expect(sum).toBe(100);
  });
});

describe('scoreProduct — 직접 제품 관련성 (25점)', () => {
  it('정확 일치는 25점', () => {
    expect(scoreProduct([exposure({ matchKind: 'exact' })]).score).toBe(25);
  });

  it('동의어 일치는 20점', () => {
    expect(scoreProduct([exposure({ matchKind: 'synonym' })]).score).toBe(20);
  });

  it('임베딩 유사도 0.85 이상은 15점', () => {
    expect(scoreProduct([exposure({ matchKind: 'embedding', similarity: 0.9 })]).score).toBe(15);
  });

  it('임베딩 유사도 0.75~0.85 는 8점', () => {
    expect(scoreProduct([exposure({ matchKind: 'embedding', similarity: 0.8 })]).score).toBe(8);
  });

  it('임베딩 유사도가 낮으면 0점', () => {
    expect(scoreProduct([exposure({ matchKind: 'embedding', similarity: 0.6 })]).score).toBe(0);
  });

  it('제품 계열이 아닌 노출은 제품 점수를 주지 않는다', () => {
    expect(scoreProduct([exposure({ exposureType: 'customer' })]).score).toBe(0);
  });

  it('여러 노출 중 가장 높은 점수를 쓴다', () => {
    const score = scoreProduct([
      exposure({ matchKind: 'fulltext' }),
      exposure({ id: 'exp-2', matchKind: 'exact' }),
    ]).score;
    expect(score).toBe(25);
  });
});

describe('scoreRevenue — 매출 근거 (20점)', () => {
  it('30% 이상은 20점', () => {
    expect(scoreRevenue([exposure({ revenueShare: 52 })]).score).toBe(20);
  });

  it('10~30% 는 14점', () => {
    expect(scoreRevenue([exposure({ revenueShare: 18 })]).score).toBe(14);
  });

  it('0 초과 10 미만은 8점', () => {
    expect(scoreRevenue([exposure({ revenueShare: 3 })]).score).toBe(8);
  });

  it('수치는 없지만 근거 문서가 있으면 5점', () => {
    expect(scoreRevenue([exposure({ evidenceId: 'ev-1' })]).score).toBe(5);
  });

  it('아무 근거도 없으면 0점', () => {
    expect(scoreRevenue([exposure()]).score).toBe(0);
  });
});

describe('scoreGeography — 지역 노출 (15점)', () => {
  it('매출 지역 일치는 15점', () => {
    const score = scoreGeography(
      [exposure({ exposureType: 'geography', exposureValue: '미국', revenueShare: 31 })],
      ['미국'],
    ).score;
    expect(score).toBe(15);
  });

  it('생산 지역만 일치하면 10점', () => {
    const score = scoreGeography(
      [exposure({ exposureType: 'geography', exposureValue: '미국' })],
      ['미국'],
    ).score;
    expect(score).toBe(10);
  });

  it('상위 개념 부분 일치는 8점', () => {
    const score = scoreGeography(
      [exposure({ exposureType: 'geography', exposureValue: '미국 텍사스' })],
      ['미국'],
    ).score;
    expect(score).toBe(8);
  });

  it('이벤트에 지역 정보가 없으면 0점', () => {
    expect(scoreGeography([exposure({ geography: '미국' })], []).score).toBe(0);
  });

  it('무관한 지역은 0점', () => {
    const score = scoreGeography(
      [exposure({ exposureType: 'geography', exposureValue: '베트남' })],
      ['미국'],
    ).score;
    expect(score).toBe(0);
  });
});

describe('scoreSupplyChain — 고객·공급망 (15점)', () => {
  it('고객사 직접은 15점', () => {
    expect(scoreSupplyChain([exposure({ exposureType: 'customer' })]).score).toBe(15);
  });

  it('고객 산업은 10점', () => {
    expect(scoreSupplyChain([exposure({ exposureType: 'customer_industry' })]).score).toBe(10);
  });

  it('공급사는 10점', () => {
    expect(scoreSupplyChain([exposure({ exposureType: 'supplier' })]).score).toBe(10);
  });

  it('경쟁사·대체재는 8점', () => {
    expect(scoreSupplyChain([exposure({ exposureType: 'competitor' })]).score).toBe(8);
    expect(scoreSupplyChain([exposure({ exposureType: 'substitute' })]).score).toBe(8);
  });

  it('제품 노출만 있으면 0점', () => {
    expect(scoreSupplyChain([exposure({ exposureType: 'product' })]).score).toBe(0);
  });
});

describe('scoreDisclosure — 공시 근거 (15점)', () => {
  it('검수된 DART 근거는 15점', () => {
    const score = scoreDisclosure([
      exposure({ evidenceId: 'ev', evidenceSourceType: 'dart', evidenceVerified: true }),
    ]).score;
    expect(score).toBe(15);
  });

  it('미검수 DART 근거는 10점', () => {
    const score = scoreDisclosure([
      exposure({ evidenceId: 'ev', evidenceSourceType: 'dart', evidenceVerified: false }),
    ]).score;
    expect(score).toBe(10);
  });

  it('뉴스 근거는 5점', () => {
    const score = scoreDisclosure([
      exposure({ evidenceId: 'ev', evidenceSourceType: 'news' }),
    ]).score;
    expect(score).toBe(5);
  });

  it('근거가 없으면 0점', () => {
    expect(scoreDisclosure([exposure()]).score).toBe(0);
  });
});

describe('scoreRecency — 최근성 (5점)', () => {
  it('6개월 내 5점', () => {
    expect(scoreRecency('2026-05-01', NOW).score).toBe(5);
  });
  it('1년 내 3점', () => {
    expect(scoreRecency('2025-11-01', NOW).score).toBe(3);
  });
  it('2년 내 1점', () => {
    expect(scoreRecency('2025-01-01', NOW).score).toBe(1);
  });
  it('2년 초과 0점', () => {
    expect(scoreRecency('2022-01-01', NOW).score).toBe(0);
  });
  it('보고서 날짜가 없으면 0점', () => {
    expect(scoreRecency(null, NOW).score).toBe(0);
  });
});

describe('scoreCandidate — 통합', () => {
  it('강한 근거를 가진 종목은 높은 점수를 받는다', () => {
    const strong = candidate({
      exposures: [
        exposure({
          matchKind: 'exact',
          revenueShare: 45,
          evidenceId: 'ev',
          evidenceSourceType: 'dart',
          evidenceVerified: true,
        }),
        exposure({
          id: 'exp-2',
          exposureType: 'geography',
          exposureValue: '미국',
          revenueShare: 31,
          evidenceId: 'ev2',
          evidenceSourceType: 'dart',
          evidenceVerified: true,
        }),
      ],
    });
    const result = scoreCandidate(strong, query, NOW);
    // 제품25 + 매출20 + 지역15 + 공시15 + 최근성5 = 80.
    // 90점대는 고객사·공급망 근거까지 있어야 도달한다.
    expect(result.total).toBe(80);
    expect(result.product).toBe(25);
    expect(result.revenue).toBe(20);
    expect(result.geography).toBe(15);
    expect(result.disclosure).toBe(15);
    expect(result.supplyChain).toBe(0);
  });

  it('공급망 근거까지 갖추면 90점대에 도달한다', () => {
    const strongest = candidate({
      exposures: [
        exposure({
          matchKind: 'exact',
          revenueShare: 45,
          evidenceId: 'ev',
          evidenceSourceType: 'dart',
          evidenceVerified: true,
        }),
        exposure({
          id: 'exp-2',
          exposureType: 'geography',
          exposureValue: '미국',
          revenueShare: 31,
        }),
        exposure({ id: 'exp-3', exposureType: 'customer', exposureValue: '미국 전력청' }),
      ],
    });
    expect(scoreCandidate(strongest, query, NOW).total).toBeGreaterThanOrEqual(90);
  });

  it('총점은 100을 넘지 않는다', () => {
    const maxed = candidate({
      exposures: [
        exposure({ matchKind: 'exact', revenueShare: 90, evidenceId: 'e', evidenceSourceType: 'dart', evidenceVerified: true }),
        exposure({ id: '2', exposureType: 'geography', exposureValue: '미국', revenueShare: 60 }),
        exposure({ id: '3', exposureType: 'customer' }),
      ],
    });
    expect(scoreCandidate(maxed, query, NOW).total).toBeLessThanOrEqual(100);
  });

  it('테마 점수는 실근거 점수가 0일 때만 붙는다', () => {
    const thematicOnly = candidate({
      latestReportDate: null,
      exposures: [exposure({ exposureType: 'policy', matchKind: 'fulltext' })],
    });
    const result = scoreCandidate(thematicOnly, { ...query, geography: [] }, NOW);
    expect(result.thematic).toBe(5);
    expect(result.total).toBe(5);
  });

  it('실근거가 있으면 테마 점수를 더하지 않는다', () => {
    const withEvidence = candidate({
      exposures: [exposure({ matchKind: 'exact', revenueShare: 40 })],
    });
    expect(scoreCandidate(withEvidence, query, NOW).thematic).toBe(0);
  });
});

describe('applyHardRules', () => {
  const strongBreakdown = scoreCandidate(
    candidate({
      exposures: [
        exposure({ matchKind: 'exact', revenueShare: 45, evidenceId: 'ev', evidenceSourceType: 'dart', evidenceVerified: true }),
      ],
    }),
    query,
    NOW,
  );

  it('R1: 종목코드가 없으면 결과에서 제외한다', () => {
    const result = applyHardRules(candidate({ stockCode: null }), strongBreakdown, 'direct', 1);
    expect(result.excluded).toBe(true);
    expect(result.reason).toBe('no_stock_code');
  });

  it('R3: 근거 링크가 없으면 thematic 으로 강등한다', () => {
    const result = applyHardRules(candidate(), strongBreakdown, 'direct', 0);
    expect(result.relationType).toBe('thematic');
  });

  it('R2: 공시·매출 근거가 모두 없으면 thematic 이고 39점으로 캡된다', () => {
    const weak = candidate({
      exposures: [exposure({ exposureType: 'customer', matchKind: 'exact' })],
      latestReportDate: '2026-05-01',
    });
    const breakdown = scoreCandidate(weak, query, NOW);
    expect(breakdown.disclosure).toBe(0);
    expect(breakdown.revenue).toBe(0);

    const result = applyHardRules(weak, breakdown, 'direct', 1);
    expect(result.relationType).toBe('thematic');
    expect(result.score).toBeLessThanOrEqual(THEMATIC_SCORE_CAP);
  });

  it('근거가 충분하면 LLM 판정을 유지한다', () => {
    const result = applyHardRules(candidate(), strongBreakdown, 'direct', 2);
    expect(result.relationType).toBe('direct');
    expect(result.excluded).toBe(false);
    expect(result.score).toBe(strongBreakdown.total);
  });
});

describe('rankCandidates', () => {
  it('종목코드 없는 기업을 제외하고 점수 순으로 정렬한다', () => {
    const strong = candidate({
      companyId: 'strong',
      exposures: [exposure({ matchKind: 'exact', revenueShare: 50, evidenceId: 'e', evidenceSourceType: 'dart', evidenceVerified: true })],
    });
    const weak = candidate({ companyId: 'weak', exposures: [exposure({ matchKind: 'fulltext' })] });
    const unlisted = candidate({ companyId: 'unlisted', stockCode: null });

    const ranked = rankCandidates([weak, unlisted, strong], query, NOW);

    expect(ranked.map((r) => r.candidate.companyId)).toEqual(['strong', 'weak']);
    expect(ranked.some((r) => r.candidate.companyId === 'unlisted')).toBe(false);
  });
});

describe('relevanceLabel', () => {
  it('점수 구간별 라벨을 준다', () => {
    expect(relevanceLabel(95)).toContain('강함');
    expect(relevanceLabel(80)).toContain('직접 사업 관련성');
    expect(relevanceLabel(65)).toContain('공급망');
    expect(relevanceLabel(45)).toContain('간접');
    expect(relevanceLabel(25)).toContain('테마');
    expect(relevanceLabel(10)).toContain('제외');
  });

  it('공개 하한선과 라벨 경계가 일치한다', () => {
    expect(relevanceLabel(PUBLIC_SCORE_FLOOR)).toContain('테마');
    expect(relevanceLabel(PUBLIC_SCORE_FLOOR - 1)).toContain('제외');
  });
});
