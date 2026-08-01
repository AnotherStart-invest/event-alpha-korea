import { describe, expect, it } from 'vitest';
import {
  EVIDENCE_MAX_SCORES,
  MAX_SCORES,
  PUBLIC_SCORE_FLOOR,
  THEMATIC_SCORE,
  THEMATIC_SCORE_CAP,
  applyHardRules,
  rankCandidates,
  relevanceLabel,
  scoreCandidate,
  scoreDisclosure,
  scoreFocus,
  scoreGeography,
  scoreIndustry,
  scoreProduct,
  scoreRecency,
  scoreRevenue,
  scoreSupplyChain,
  specificityWeight,
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
    // 기본값은 "이 용어를 가진 회사가 하나뿐" — 종목을 정확히 특정하는 매칭이다.
    termCompanyCount: 1,
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
    // 기본값은 "제품 1개 = 매칭 1개", 즉 사업이 완전히 집중된 회사다.
    productExposureCount: 1,
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
  it('실근거 항목 만점 합은 100이다', () => {
    const sum = Object.values(EVIDENCE_MAX_SCORES).reduce((a, b) => a + b, 0);
    expect(sum).toBe(100);
  });

  it('테마 점수는 100에 포함되지 않는다 — 다른 항목과 배타적이다', () => {
    // 넣으면 도달할 수 없는 만점(105)이 생긴다. thematic 은 실근거가
    // 하나도 없을 때만 붙으므로 정의상 다른 항목과 같이 나올 수 없다.
    expect(EVIDENCE_MAX_SCORES).not.toHaveProperty('thematic');
    expect(MAX_SCORES.thematic).toBe(THEMATIC_SCORE);
  });
});

describe('scoreProduct — 직접 제품 관련성 (20점)', () => {
  it('정확 일치는 만점', () => {
    expect(scoreProduct([exposure({ matchKind: 'exact' })]).score).toBe(EVIDENCE_MAX_SCORES.product);
  });

  it('동의어 일치는 16점', () => {
    expect(scoreProduct([exposure({ matchKind: 'synonym' })]).score).toBe(16);
  });

  it('임베딩 유사도 0.85 이상은 12점', () => {
    expect(scoreProduct([exposure({ matchKind: 'embedding', similarity: 0.9 })]).score).toBe(12);
  });

  it('임베딩 유사도 0.75~0.85 는 6점', () => {
    expect(scoreProduct([exposure({ matchKind: 'embedding', similarity: 0.8 })]).score).toBe(6);
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
    expect(score).toBe(EVIDENCE_MAX_SCORES.product);
  });
});

describe('scoreRevenue — 매출 근거 (15점)', () => {
  it('30% 이상은 만점', () => {
    expect(scoreRevenue([exposure({ revenueShare: 52 })]).score).toBe(EVIDENCE_MAX_SCORES.revenue);
  });

  it('10~30% 는 11점', () => {
    expect(scoreRevenue([exposure({ revenueShare: 18 })]).score).toBe(11);
  });

  it('0 초과 10 미만은 6점', () => {
    expect(scoreRevenue([exposure({ revenueShare: 3 })]).score).toBe(6);
  });

  it('수치는 없지만 근거 문서가 있으면 4점', () => {
    expect(scoreRevenue([exposure({ evidenceId: 'ev-1' })]).score).toBe(4);
  });

  it('아무 근거도 없으면 0점', () => {
    expect(scoreRevenue([exposure()]).score).toBe(0);
  });
});

describe('scoreGeography — 지역 노출 (10점)', () => {
  it('매출 지역 일치는 만점', () => {
    const score = scoreGeography(
      [exposure({ exposureType: 'geography', exposureValue: '미국', revenueShare: 31 })],
      ['미국'],
    ).score;
    expect(score).toBe(EVIDENCE_MAX_SCORES.geography);
  });

  it('생산 지역만 일치하면 7점', () => {
    const score = scoreGeography(
      [exposure({ exposureType: 'geography', exposureValue: '미국' })],
      ['미국'],
    ).score;
    expect(score).toBe(7);
  });

  it('상위 개념 부분 일치는 5점', () => {
    const score = scoreGeography(
      [exposure({ exposureType: 'geography', exposureValue: '미국 텍사스' })],
      ['미국'],
    ).score;
    expect(score).toBe(5);
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

describe('scoreSupplyChain — 고객·공급망 (10점)', () => {
  it('고객사 직접은 만점', () => {
    expect(scoreSupplyChain([exposure({ exposureType: 'customer' })]).score).toBe(EVIDENCE_MAX_SCORES.supplyChain);
  });

  it('고객 산업은 7점', () => {
    expect(scoreSupplyChain([exposure({ exposureType: 'customer_industry' })]).score).toBe(7);
  });

  it('공급사는 7점', () => {
    expect(scoreSupplyChain([exposure({ exposureType: 'supplier' })]).score).toBe(7);
  });

  it('경쟁사·대체재는 5점', () => {
    expect(scoreSupplyChain([exposure({ exposureType: 'competitor' })]).score).toBe(5);
    expect(scoreSupplyChain([exposure({ exposureType: 'substitute' })]).score).toBe(5);
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

describe('용어 변별력 — "단어가 겹친다" ≠ "관련이 있다"', () => {
  it('그 용어를 가진 회사가 하나뿐이면 만점', () => {
    expect(specificityWeight(1)).toBe(1);
    expect(scoreProduct([exposure({ termCompanyCount: 1 })]).score).toBe(
      EVIDENCE_MAX_SCORES.product,
    );
  });

  it('흔한 용어일수록 깎인다', () => {
    expect(scoreProduct([exposure({ termCompanyCount: 3 })]).score).toBe(16);
    expect(scoreProduct([exposure({ termCompanyCount: 10 })]).score).toBe(10);
    expect(scoreProduct([exposure({ termCompanyCount: 26 })]).score).toBe(5);
  });

  it('실측 회귀: "합성수지"(12개사)가 "폐배터리 리사이클"(1개사)과 동점이면 안 된다', () => {
    // 15개사를 넘는 용어("반도체" 26 · "지주회사" 33)는 findBroadTerms 가 채점 전에
    // 통째로 버린다. 이 가중치가 실제로 다루는 구간은 그 아래 4~15개사 —
    // 계단만 있을 때 12개사짜리가 1개사짜리와 동점이 되던 회색지대다.
    const 합성수지 = scoreProduct([exposure({ exposureValue: '합성수지', termCompanyCount: 12 })]).score;
    const 폐배터리 = scoreProduct([exposure({ exposureValue: '폐배터리 리사이클' })]).score;
    expect(폐배터리).toBeGreaterThan(합성수지);
    expect(폐배터리 - 합성수지).toBeGreaterThanOrEqual(10);
  });

  it('몇 개사가 같은 용어를 쓰는지 근거 문구에 남긴다', () => {
    const note = scoreProduct([exposure({ termCompanyCount: 26 })]).note;
    expect(note).toContain('26개사');
  });
});

describe('applyHardRules R6 — 흔한 용어 하나로만 걸린 종목', () => {
  const generic = () =>
    candidate({
      industryName: '수산물 가공 및 저장 처리업',
      exposures: [
        exposure({
          exposureValue: '소프트웨어 개발',
          termCompanyCount: 10,
          evidenceId: 'ev',
          evidenceSourceType: 'exchange',
        }),
      ],
    });

  it('업종도 안 맞으면 아예 제외한다', () => {
    // 원양어업 회사가 소프트웨어 뉴스에 붙던 경로. 점수를 깎는 것만으로는
    // 화면에 남아서, 읽는 사람이 하나씩 걸러내야 한다.
    const breakdown = scoreCandidate(generic(), { ...query, industries: ['소프트웨어'] }, NOW);
    const result = applyHardRules(generic(), breakdown, 'direct', 1);

    expect(result.excluded).toBe(true);
    expect(result.reason).toBe('generic_term_only');
  });

  it('업종이 맞으면 남긴다 — 흔한 용어라도 업종이 받쳐 주면 근거다', () => {
    const software = candidate({
      industryName: '소프트웨어 개발 및 공급업',
      exposures: [
        exposure({
          exposureValue: '소프트웨어 개발',
          termCompanyCount: 10,
          evidenceId: 'ev',
          evidenceSourceType: 'exchange',
        }),
      ],
    });
    const breakdown = scoreCandidate(software, { ...query, industries: ['소프트웨어'] }, NOW);
    expect(breakdown.industry).toBeGreaterThan(0);
    expect(applyHardRules(software, breakdown, 'direct', 1).excluded).toBe(false);
  });

  it('변별력 있는 용어가 하나라도 있으면 남긴다', () => {
    // "반도체" 로도 걸리고 "메모리 테스트 소켓" 으로도 걸린 기업은 후자가 근거다.
    const mixed = candidate({
      industryName: '무관한 업종',
      exposures: [
        exposure({ exposureValue: '합성수지', termCompanyCount: 12 }),
        exposure({ id: 'e2', exposureValue: '메모리 테스트 소켓', termCompanyCount: 1 }),
      ],
    });
    const breakdown = scoreCandidate(mixed, query, NOW);
    expect(applyHardRules(mixed, breakdown, 'direct', 1).excluded).toBe(false);
  });

  it('제품이 아닌 근거(고객사 등)만 있으면 이 룰을 적용하지 않는다', () => {
    const supply = candidate({
      industryName: '무관한 업종',
      exposures: [exposure({ exposureType: 'customer', termCompanyCount: 40 })],
    });
    const breakdown = scoreCandidate(supply, query, NOW);
    expect(applyHardRules(supply, breakdown, 'direct', 1).reason).not.toBe('generic_term_only');
  });
});

describe('scoreFocus — 사업 집중도 (20점)', () => {
  it('파는 게 그것뿐이면 만점', () => {
    expect(scoreFocus([exposure()], 1).score).toBe(EVIDENCE_MAX_SCORES.focus);
  });

  it('제품이 많을수록 한 건의 매칭은 약해진다', () => {
    expect(scoreFocus([exposure()], 2).score).toBe(10);
    expect(scoreFocus([exposure()], 8).score).toBe(3);
    expect(scoreFocus([exposure()], 12).score).toBe(2);
  });

  it('여러 제품이 걸리면 그만큼 올라간다', () => {
    const two = [exposure(), exposure({ id: '2', normalizedValue: '차단기' })];
    expect(scoreFocus(two, 4).score).toBe(10);
  });

  it('제품이 아닌 노출(지역·고객)은 분자에 넣지 않는다', () => {
    expect(scoreFocus([exposure({ exposureType: 'geography' })], 4).score).toBe(0);
  });

  it('분모를 모르면 0점 — 데이터 없는 기업이 유리해지면 안 된다', () => {
    expect(scoreFocus([exposure()], 0).score).toBe(0);
  });

  it('실측 회귀: 원양어업 회사가 소프트웨어 한 줄로 걸린 경우', () => {
    // 유학생 비자 이벤트에서 라온시큐어(제품 1개)와 사조산업(제품 12개)이
    // 똑같이 35점을 받았다. 집중도가 이 둘을 갈라야 한다.
    const 라온시큐어 = scoreFocus([exposure()], 1).score;
    const 사조산업 = scoreFocus([exposure()], 12).score;
    expect(라온시큐어).toBeGreaterThan(사조산업);
    expect(라온시큐어 - 사조산업).toBeGreaterThanOrEqual(15);
  });
});

describe('scoreIndustry — 업종 적합 (10점)', () => {
  it('업종명이 이벤트 산업을 포함하면 만점', () => {
    expect(scoreIndustry('소프트웨어 개발 및 공급업', ['소프트웨어']).score).toBe(EVIDENCE_MAX_SCORES.industry);
  });

  it('무관한 업종은 0점', () => {
    expect(scoreIndustry('수산물 가공 및 저장 처리업', ['소프트웨어']).score).toBe(0);
  });

  it('띄어쓰기 차이를 무시한다', () => {
    expect(scoreIndustry('전기장비 제조업', ['전기 장비']).score).toBe(EVIDENCE_MAX_SCORES.industry);
  });

  it('업종이나 이벤트 산업이 비면 0점', () => {
    expect(scoreIndustry(null, ['소프트웨어']).score).toBe(0);
    expect(scoreIndustry('소프트웨어 개발업', []).score).toBe(0);
  });

  it('한 글자짜리 산업어로는 점수를 주지 않는다 — 오탐이 너무 넓다', () => {
    expect(scoreIndustry('수산물 가공업', ['물']).score).toBe(0);
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
    // 제품20 + 집중도20 + 매출15 + 공시15 + 지역10 + 최근성5 = 85.
    // 업종('전기장비' vs 이벤트 '전력기기')은 안 맞아 0점이다.
    // 90점대는 고객사·공급망 근거까지 있어야 도달한다.
    expect(result.total).toBe(85);
    expect(result.product).toBe(20);
    expect(result.focus).toBe(20);
    expect(result.revenue).toBe(15);
    expect(result.geography).toBe(10);
    expect(result.disclosure).toBe(15);
    expect(result.industry).toBe(0);
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
