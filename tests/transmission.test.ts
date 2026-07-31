import { describe, expect, it } from 'vitest';
import { transmissionSchema } from '@/lib/llm/schemas';
import { TRANSMISSION_SYSTEM } from '@/lib/llm/prompts';
import { findBannedPhrases } from '@/lib/shared/banned-words';

/**
 * 이 경로의 안전성은 프롬프트가 아니라 **스키마**가 보장한다.
 * 기업명을 담을 필드가 없으면 LLM 은 종목을 지어낼 방법이 없다.
 */
describe('transmissionSchema', () => {
  const valid = {
    is_traceable: true,
    primary_variable: '중국산 열연강판 수입단가',
    variable_direction: 'down' as const,
    steps: [
      {
        step: '중국산 저가 철강 유입 확대로 국내 철강재 판매단가가 하락한다',
        affected_terms: ['후판', '열연강판'],
        industry_terms: ['1차 철강 제조업'],
        direction: 'negative' as const,
        relation: 'direct' as const,
        reason: '판매단가 하락으로 철강 생산업체의 롤마진이 축소된다',
      },
      {
        step: '철강을 원재료로 쓰는 후방 산업의 투입원가가 낮아진다',
        affected_terms: ['선박', '자동차부품'],
        industry_terms: ['선박 건조업'],
        direction: 'positive' as const,
        relation: 'supply_chain' as const,
        reason: '강재 매입단가 하락으로 제조원가가 낮아진다',
      },
    ],
  };

  it('정상 응답을 통과시킨다', () => {
    expect(transmissionSchema.safeParse(valid).success).toBe(true);
  });

  it('한 이벤트 안에서 단계마다 방향이 뒤집힐 수 있다 — 이게 이 경로의 존재 이유다', () => {
    const parsed = transmissionSchema.parse(valid);
    expect(parsed.steps.map((s) => s.direction)).toEqual(['negative', 'positive']);
  });

  it('기업명을 담을 필드가 없다 — 종목을 지어낼 구멍 자체가 없어야 한다', () => {
    const fields = Object.keys(transmissionSchema.shape);
    const stepFields = Object.keys(transmissionSchema.shape.steps.element.shape);
    for (const name of [...fields, ...stepFields]) {
      expect(name).not.toMatch(/company|corp|ticker|stock|기업|종목/i);
    }
  });

  it('알 수 없는 필드를 끼워 넣어도 결과에 남지 않는다', () => {
    const parsed = transmissionSchema.parse({
      ...valid,
      steps: [{ ...valid.steps[0], company_names: ['POSCO홀딩스'] }],
    });
    expect(parsed.steps[0]).not.toHaveProperty('company_names');
  });

  it('경로를 못 그리면 steps 가 비어도 통과한다 — 억지로 채우는 것보다 낫다', () => {
    const empty = { ...valid, is_traceable: false, steps: [] };
    expect(transmissionSchema.safeParse(empty).success).toBe(true);
  });

  it('단계는 4개까지만 받는다', () => {
    const tooMany = { ...valid, steps: Array.from({ length: 5 }, () => valid.steps[0]) };
    expect(transmissionSchema.safeParse(tooMany).success).toBe(false);
  });

  it('검색어 없는 단계는 거부한다 — 종목을 찾을 방법이 없다', () => {
    const noTerms = { ...valid, steps: [{ ...valid.steps[0], affected_terms: [] }] };
    expect(transmissionSchema.safeParse(noTerms).success).toBe(false);
  });

  it('방향은 정해진 값만 받는다', () => {
    const bogus = { ...valid, steps: [{ ...valid.steps[0], direction: '상승' }] };
    expect(transmissionSchema.safeParse(bogus).success).toBe(false);
  });
});

describe('TRANSMISSION_SYSTEM', () => {
  it('금지 표현은 금지 규칙 줄에서만 등장한다', () => {
    // 프롬프트는 금지어를 이름으로 불러 금지해야 하므로 등장 자체는 정상이다.
    // 다만 **예시 문장**에 흘러들면 모델이 그대로 따라 쓴다.
    const rest = TRANSMISSION_SYSTEM.split('\n')
      .filter((line) => !line.includes('쓰지 않는다'))
      .join('\n');
    expect(findBannedPhrases(rest)).toEqual([]);
  });

  it('기업명 금지와 수요 측 지시가 프롬프트에 남아 있다', () => {
    expect(TRANSMISSION_SYSTEM).toContain('기업명');
    expect(TRANSMISSION_SYSTEM).toContain('수요 측');
  });

  /**
   * 실측 사고 재발 방지. affected_terms 는 KRX 주요제품(= 파는 것)과 대조되는데
   * 수요 측 단계에 원재료 이름을 적으면 그 원재료를 만들어 파는 기업이 잡힌다.
   * 배터리 이벤트에서 에코프로비엠(양극활물질)은 positive, 신성에스티(배터리
   * 부품)는 negative 로 붙어 같은 역할의 기업에 반대 방향이 매겨졌다.
   */
  it('"파는 것을 쓰라"는 지시가 프롬프트에 남아 있다 — 방향이 뒤집히는 사고의 원인이었다', () => {
    expect(TRANSMISSION_SYSTEM).toContain('파는 것');
    expect(TRANSMISSION_SYSTEM).toContain('사는 것을 쓰지 않는다');
  });
});
