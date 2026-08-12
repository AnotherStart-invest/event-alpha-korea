import { describe, expect, it } from 'vitest';
import { DISPLAY_SCORE_FLOOR, VISIBLE_PER_STEP, buildValueChain } from '@/lib/queries/events';
import type { ImpactWithCompany } from '@/lib/queries/events';
import type { EventTransmissionStepRow } from '@/lib/db/types';

/**
 * 밸류체인 배열 규칙.
 *
 * 회귀 기준은 실제로 화면에 나왔던 사고다 — "유학생 취업 비자" 이벤트에
 * 원양어업 회사(사조산업)가 "소프트웨어 개발" 문자열 하나로 붙어, SK·라온시큐어와
 * 똑같이 35점을 받고 한 줄에 나란히 섰다.
 */

function step(order: number, overrides: Partial<EventTransmissionStepRow> = {}) {
  return {
    id: `step-${order}`,
    event_id: 'ev-1',
    step_order: order,
    description: `${order}단계`,
    direction: 'negative',
    relation: 'supply_chain',
    reason: null,
    chain_position: order === 1 ? 'upstream' : 'downstream',
    ...overrides,
  } as EventTransmissionStepRow;
}

function impact(
  name: string,
  overrides: {
    score?: number;
    stepOrder?: number | null;
    productCount?: number;
    marketCap?: number | null;
    market?: string;
    focus?: number;
    origin?: 'keyword';
  } = {},
): ImpactWithCompany {
  const { score = 35, stepOrder = 1, productCount = 1, marketCap = 1_000_000_000_000 } = overrides;
  return {
    id: `impact-${name}`,
    impact_direction: 'negative',
    impact_level: 'low',
    relation_type: 'supply_chain',
    relevance_score: score,
    confidence_score: null,
    rationale: null,
    transmission_path: [],
    step_order: stepOrder,
    missing_evidence: [],
    // 밸류체인 레인에는 **믿을 만한 근거**(원문 언급/AI 지목)만 오른다.
    // 기본 픽스처를 llm 로 두는 이유다 — 마커가 없으면 키워드 매칭으로 취급돼 걸러진다.
    score_breakdown: {
      total: score,
      llm: overrides.origin === 'keyword' ? undefined : score,
      ...(overrides.focus === undefined ? {} : { focus: overrides.focus }),
      notes: [],
    } as never,
    company: {
      id: `c-${name}`,
      company_name: name,
      stock_code: '000001',
      market: overrides.market ?? 'KOSPI',
      industry_name: null,
      latest_report_date: null,
      market_cap: marketCap,
      price_updated_at: null,
      product_exposure_count: productCount,
    },
    evidence: [],
  };
}

describe('buildValueChain — 단계별 배열', () => {
  it('종목을 걸린 단계에 붙인다', () => {
    const chain = buildValueChain(
      [step(1), step(2)],
      [impact('가', { stepOrder: 1 }), impact('나', { stepOrder: 2 })],
    );
    expect(chain.lanes).toHaveLength(2);
    expect(chain.lanes[0].shown.map((i) => i.company?.company_name)).toEqual(['가']);
    expect(chain.lanes[1].shown.map((i) => i.company?.company_name)).toEqual(['나']);
    expect(chain.hasChain).toBe(true);
  });

  it('단계가 없는 종목은 unassigned 로 간다 — 기사 언급·동종 확장으로 붙은 것들', () => {
    const chain = buildValueChain([step(1)], [impact('가', { stepOrder: null })]);
    expect(chain.lanes[0].shown).toHaveLength(0);
    expect(chain.unassigned.shown.map((i) => i.company?.company_name)).toEqual(['가']);
    expect(chain.hasChain).toBe(false);
  });

  it('단계에 걸린 종목이 하나도 없으면 밸류체인을 그리지 않는다', () => {
    expect(buildValueChain([step(1)], []).hasChain).toBe(false);
  });
});

describe('buildValueChain — 순위', () => {
  it('관련도가 1순위다', () => {
    const chain = buildValueChain(
      [step(1)],
      [impact('낮음', { score: 22 }), impact('높음', { score: 60 })],
    );
    expect(chain.lanes[0].shown[0].company?.company_name).toBe('높음');
  });

  it('실측 회귀: 동점일 때 제품 가짓수가 적은 회사가 먼저다', () => {
    // 전부 35점 동점이던 그 10종목. 가짓수만이 이들을 가른다.
    const chain = buildValueChain(
      [step(1)],
      [
        impact('사조산업', { productCount: 12, marketCap: 600_000_000_000 }),
        impact('SK', { productCount: 8, marketCap: 137_000_000_000_000 }),
        impact('비상교육', { productCount: 2, marketCap: 100_000_000_000 }),
        impact('라온시큐어', { productCount: 1, marketCap: 200_000_000_000 }),
      ],
    );
    const shown = chain.lanes[0].shown.map((i) => i.company?.company_name);
    expect(shown).toEqual(['라온시큐어', '비상교육', 'SK']);
    // 시총이 가장 큰 SK 가 1등이 아니고, 원양어업 회사는 아예 안 나온다.
    expect(shown).not.toContain('사조산업');
  });

  it('가짓수를 모르는 기업은 뒤로 — 데이터 없는 쪽이 1등이 되면 안 된다', () => {
    const chain = buildValueChain(
      [step(1)],
      [impact('미상', { productCount: 0 }), impact('집중', { productCount: 3 })],
    );
    expect(chain.lanes[0].shown[0].company?.company_name).toBe('집중');
  });

  it('가짓수까지 같으면 시총이 큰 쪽이 먼저다', () => {
    const chain = buildValueChain(
      [step(1)],
      [
        impact('작은회사', { productCount: 2, marketCap: 50_000_000_000 }),
        impact('큰회사', { productCount: 2, marketCap: 90_000_000_000_000 }),
      ],
    );
    expect(chain.lanes[0].shown[0].company?.company_name).toBe('큰회사');
  });
});

describe('buildValueChain — 노출 제한', () => {
  it(`단계당 ${VISIBLE_PER_STEP}종목까지만 싣고 나머지는 세기만 한다`, () => {
    const many = Array.from({ length: 9 }, (_, i) =>
      impact(`종목${i}`, { productCount: i + 1 }),
    );
    const chain = buildValueChain([step(1)], many);
    expect(chain.lanes[0].shown).toHaveLength(VISIBLE_PER_STEP);
    expect(chain.lanes[0].hiddenCount).toBe(9 - VISIBLE_PER_STEP);
  });

  it('코넥스는 거래가 사실상 안 되므로 아예 뺀다', () => {
    const chain = buildValueChain(
      [step(1)],
      [impact('코넥스종목', { market: 'KONEX' }), impact('코스피종목', { productCount: 5 })],
    );
    expect(chain.lanes[0].shown.map((i) => i.company?.company_name)).toEqual(['코스피종목']);
    expect(chain.lanes[0].hiddenCount).toBe(1);
  });
});

describe('buildValueChain — 근거 없는 종목 배제', () => {
  it('키워드 문자열 매칭만으로 붙은 종목은 레인에 올리지 않는다', () => {
    // 실측(공개 종목 3,000건): 키워드 매칭이 77% 였고 공개 이벤트의 49% 가
    // 이것만으로 채워져 있었다. 단계가 논리적이어도 그 단계에 어느 회사가
    // 걸리는지를 문자열로 고른 것이라 "왜 이 회사인가" 를 말하지 못한다.
    const chain = buildValueChain(
      [step(1)],
      [impact('키워드종목', { origin: 'keyword' }), impact('AI지목종목')],
    );
    expect(chain.lanes[0].shown.map((i) => i.company?.company_name)).toEqual(['AI지목종목']);
    expect(chain.lanes[0].hiddenCount).toBe(1);
  });

  it('키워드 종목만 있으면 밸류체인을 그리지 않는다 — 빈 화면이 사실에 가깝다', () => {
    const chain = buildValueChain([step(1)], [impact('키워드종목', { origin: 'keyword' })]);
    expect(chain.hasChain).toBe(false);
  });
});

describe('buildValueChain — 옛 점수 호환', () => {
  it('새 체계로 채점된 행은 컷 아래면 뺀다', () => {
    const chain = buildValueChain(
      [step(1)],
      [impact('약함', { score: DISPLAY_SCORE_FLOOR - 1, focus: 2 })],
    );
    expect(chain.lanes[0].shown).toHaveLength(0);
    expect(chain.lanes[0].hiddenCount).toBe(1);
  });

  it('옛 체계로 채점된 행에는 컷을 적용하지 않는다 — 최대가 35점이라 화면이 전부 빈다', () => {
    // focus 가 없으면 0009 이전 행이다. 재추적 전까지는 순위로만 거른다.
    const chain = buildValueChain([step(1)], [impact('옛행', { score: 35 })]);
    expect(chain.lanes[0].shown).toHaveLength(1);
  });
});
