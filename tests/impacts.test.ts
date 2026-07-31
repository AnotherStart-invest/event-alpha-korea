import { describe, expect, it } from 'vitest';
import { buildCandidateBlock, chunkCandidates, validateImpacts } from '@/lib/matching/impacts';
import type { Candidate, EventQuery, MatchedExposure } from '@/lib/matching/types';
import type { ImpactJudgement } from '@/lib/llm/schemas';

const NOW = new Date('2026-07-31T00:00:00Z');

const query: EventQuery = {
  industries: [],
  products: ['변압기'],
  rawMaterials: [],
  customerGroups: [],
  geography: ['미국'],
};

function exposure(overrides: Partial<MatchedExposure> = {}): MatchedExposure {
  return {
    id: 'exp-1',
    exposureType: 'product',
    exposureValue: '변압기',
    normalizedValue: '변압기',
    revenueShare: 40,
    geography: null,
    direction: null,
    verified: true,
    evidenceId: 'ev-1',
    evidenceSourceType: 'dart',
    evidenceVerified: true,
    matchKind: 'exact',
    similarity: null,
    matchedKeyword: '변압기',
    ...overrides,
  };
}

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    companyId: 'company-a',
    companyName: '테스트전기',
    stockCode: '000001',
    market: 'KOSPI',
    industryName: '전기장비',
    latestReportDate: '2026-03-15',
    exposures: [exposure()],
    ...overrides,
  };
}

function judgement(overrides: Partial<ImpactJudgement> = {}): ImpactJudgement {
  return {
    company_id: 'company-a',
    impact_direction: 'positive',
    impact_level: 'medium',
    relation_type: 'direct',
    confidence_score: 70,
    rationale: '북미 변압기 매출 비중이 높아 긍정 영향 가능성이 있습니다.',
    transmission_path: ['관세 인상', '비중국 공급사 수주 기회 확대'],
    evidence_ids: ['ev-1'],
    missing_evidence: ['북미 매출 비중'],
    invalidation_conditions: ['정책이 시행되지 않는 경우'],
    ...overrides,
  };
}

describe('validateImpacts — 존재하지 않는 종목 생성 방지 (I1)', () => {
  it('후보 목록에 없는 company_id 는 버린다', () => {
    const result = validateImpacts(
      [judgement(), judgement({ company_id: 'hallucinated-company' })],
      [candidate()],
      query,
      NOW,
    );
    expect(result.impacts).toHaveLength(1);
    expect(result.stats.droppedUnknownCompany).toBe(1);
    expect(result.impacts[0].companyId).toBe('company-a');
  });

  it('후보가 전혀 없으면 결과도 비어 있다', () => {
    const result = validateImpacts([judgement()], [], query, NOW);
    expect(result.impacts).toHaveLength(0);
    expect(result.stats.droppedUnknownCompany).toBe(1);
  });
});

describe('validateImpacts — 종목코드 누락 방지 (I2)', () => {
  it('종목코드 없는 기업은 결과에서 제외한다', () => {
    const result = validateImpacts(
      [judgement()],
      [candidate({ stockCode: null })],
      query,
      NOW,
    );
    expect(result.impacts).toHaveLength(0);
    expect(result.stats.droppedNoStockCode).toBe(1);
  });

  it('통과한 결과는 모두 종목코드를 가진다', () => {
    const result = validateImpacts([judgement()], [candidate()], query, NOW);
    for (const impact of result.impacts) {
      expect(impact.stockCode).toMatch(/^\d{6}$/);
    }
  });
});

describe('validateImpacts — 근거 검증 (I4)', () => {
  it('제공되지 않은 evidence_id 는 제거한다', () => {
    const result = validateImpacts(
      [judgement({ evidence_ids: ['ev-1', 'ev-does-not-exist'] })],
      [candidate()],
      query,
      NOW,
    );
    expect(result.impacts[0].evidenceIds).toEqual(['ev-1']);
  });

  it('근거가 전부 가짜면 thematic 으로 강등된다', () => {
    const result = validateImpacts(
      [judgement({ evidence_ids: ['fake-1', 'fake-2'] })],
      [candidate()],
      query,
      NOW,
    );
    expect(result.impacts[0].evidenceIds).toEqual([]);
    expect(result.impacts[0].relationType).toBe('thematic');
  });
});

describe('validateImpacts — 낮은 근거 종목의 thematic 강등 (I5)', () => {
  it('공시·매출 근거가 없으면 thematic 이고 39점 이하다', () => {
    const weak = candidate({
      exposures: [
        exposure({ revenueShare: null, evidenceId: null, evidenceSourceType: null, exposureType: 'customer' }),
      ],
    });
    const result = validateImpacts([judgement()], [weak], query, NOW);

    expect(result.impacts[0].relationType).toBe('thematic');
    expect(result.impacts[0].relevanceScore).toBeLessThanOrEqual(39);
    expect(result.stats.demotedToThematic).toBe(1);
  });

  it('근거가 충분하면 LLM 이 준 relation_type 을 유지한다', () => {
    const result = validateImpacts([judgement()], [candidate()], query, NOW);
    expect(result.impacts[0].relationType).toBe('direct');
    expect(result.impacts[0].relevanceScore).toBeGreaterThan(39);
  });
});

describe('validateImpacts — 금지 표현', () => {
  it('rationale 에 금지 표현이 있으면 버린다', () => {
    const result = validateImpacts(
      [judgement({ rationale: '목표주가 12만원으로 상향이 예상됩니다.' })],
      [candidate()],
      query,
      NOW,
    );
    expect(result.impacts).toHaveLength(0);
    expect(result.stats.droppedBannedPhrase).toBe(1);
  });

  it('전파 경로에 금지 표현이 있어도 버린다', () => {
    const result = validateImpacts(
      [judgement({ transmission_path: ['지금 매수 기회'] })],
      [candidate()],
      query,
      NOW,
    );
    expect(result.stats.droppedBannedPhrase).toBe(1);
  });
});

describe('validateImpacts — 긍정·부정 분류', () => {
  it('방향을 그대로 보존한다', () => {
    const other = candidate({ companyId: 'company-b', companyName: '피해기업', stockCode: '000002' });
    const result = validateImpacts(
      [
        judgement({ company_id: 'company-a', impact_direction: 'positive' }),
        judgement({ company_id: 'company-b', impact_direction: 'negative' }),
      ],
      [candidate(), other],
      query,
      NOW,
    );
    const directions = Object.fromEntries(result.impacts.map((i) => [i.companyId, i.impactDirection]));
    expect(directions['company-a']).toBe('positive');
    expect(directions['company-b']).toBe('negative');
  });

  it('같은 기업이 중복으로 오면 하나만 남긴다', () => {
    const result = validateImpacts([judgement(), judgement()], [candidate()], query, NOW);
    expect(result.impacts).toHaveLength(1);
  });

  it('점수 내림차순으로 정렬한다', () => {
    const weak = candidate({
      companyId: 'company-b',
      stockCode: '000002',
      exposures: [exposure({ id: 'e2', revenueShare: null, evidenceId: null, evidenceSourceType: null })],
    });
    const result = validateImpacts(
      [judgement({ company_id: 'company-b' }), judgement({ company_id: 'company-a' })],
      [candidate(), weak],
      query,
      NOW,
    );
    expect(result.impacts[0].relevanceScore).toBeGreaterThanOrEqual(result.impacts[1].relevanceScore);
  });
});

describe('buildCandidateBlock', () => {
  it('company_id 와 근거 id 를 프롬프트에 명시한다', () => {
    const evidence = new Map([
      [
        'ev-1',
        {
          id: 'ev-1',
          source_type: 'dart',
          source_title: '사업보고서',
          excerpt: '초고압 변압기를 생산한다.',
          source_date: '2026-03-15',
        },
      ],
    ]);
    const block = buildCandidateBlock([candidate()], evidence);
    expect(block).toContain('company_id=company-a');
    expect(block).toContain('000001');
    expect(block).toContain('[ev-1]');
    expect(block).toContain('revenue_share=40');
  });

  it('근거가 없으면 "없음"으로 표기한다', () => {
    const bare = candidate({ exposures: [exposure({ evidenceId: null })] });
    expect(buildCandidateBlock([bare], new Map())).toContain('근거: 없음');
  });
});

describe('chunkCandidates', () => {
  it('배치 크기로 자른다', () => {
    const many = Array.from({ length: 95 }, (_, i) =>
      candidate({ companyId: `c-${i}`, stockCode: String(i).padStart(6, '0') }),
    );
    const chunks = chunkCandidates(many, 40);
    expect(chunks.map((c) => c.length)).toEqual([40, 40, 15]);
  });

  it('빈 배열은 빈 청크', () => {
    expect(chunkCandidates([])).toEqual([]);
  });
});
