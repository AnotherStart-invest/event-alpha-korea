import { describe, expect, it } from 'vitest';
import { MAX_COMPANIES, formatBroadcast, type BroadcastInput } from '@/lib/telegram/format';

/**
 * 채널 글은 사이트보다 정정이 어렵다. 틀린 내용이 나가면 회수가 안 된다.
 * 그래서 포맷보다 **무엇을 싣지 않는가**가 더 중요하다.
 */

function input(overrides: Partial<BroadcastInput> = {}): BroadcastInput {
  return {
    event: {
      id: 'ev-1',
      title: '호르무즈 해협 유조선 피격',
      event_type: 'geopolitics_logistics',
      primary_variable: '중동 발 국제 해상 운임 지수',
      variable_direction: 'up',
      time_horizon: 'short',
    },
    steps: [
      { step_order: 1, description: '항해 리스크 상승으로 우회 항로와 보험료가 오른다' },
      { step_order: 2, description: '운임 상승이 해운사 수익성을 개선한다' },
    ],
    requirements: [
      { requirement_type: 'evidence_to_check', description: '컨테이너 운임 지수 변동폭' },
      { requirement_type: 'invalidation_condition', description: '사건 전 주가에 이미 반영된 경우' },
    ],
    companies: [
      { name: 'HMM', stockCode: '011200', reason: '컨테이너 선사', direction: 'positive' },
      { name: '현대자동차', stockCode: '005380', reason: '수출 물류비', direction: 'negative' },
    ],
    siteUrl: 'https://eventalpha.org',
    ...overrides,
  };
}

describe('formatBroadcast — 글 하나만 읽어도 값이 있어야 한다', () => {
  const text = formatBroadcast(input());

  it('사건·변수·경로·종목·확인할 것이 모두 들어간다', () => {
    expect(text).toContain('호르무즈 해협 유조선 피격');
    expect(text).toContain('중동 발 국제 해상 운임 지수');
    expect(text).toContain('항해 리스크 상승');
    expect(text).toContain('HMM');
    expect(text).toContain('컨테이너 운임 지수 변동폭');
  });

  it('수혜와 부담을 갈라 놓는다', () => {
    expect(text).toMatch(/수혜 가능[\s\S]*HMM/);
    expect(text).toMatch(/부담 가능[\s\S]*현대자동차/);
  });

  it('사이트 링크와 고지문이 항상 붙는다', () => {
    expect(text).toContain('https://eventalpha.org/events/ev-1');
    expect(text).toContain('투자 권유가 아닙니다');
  });

  it('방향 화살표를 붙인다', () => {
    expect(text).toContain('▲');
  });
});

describe('formatBroadcast — 안전장치', () => {
  it('HTML 특수문자를 escape 한다 — 안 하면 전송이 통째로 실패한다', () => {
    const text = formatBroadcast(
      input({
        event: { ...input().event, title: '<b>주가</b> & 실적 > 전망' },
      }),
    );
    expect(text).toContain('&lt;b&gt;주가&lt;/b&gt; &amp; 실적 &gt; 전망');
  });

  it('종목이 없어도 글이 만들어진다', () => {
    const text = formatBroadcast(input({ companies: [] }));
    expect(text).toContain('호르무즈');
    expect(text).not.toContain('수혜 가능');
    expect(text).toContain('투자 권유가 아닙니다');
  });

  it(`종목은 방향별로 ${MAX_COMPANIES}개까지만 싣는다`, () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      name: `종목${i}`,
      stockCode: null,
      reason: null,
      direction: 'positive' as const,
    }));
    const text = formatBroadcast(input({ companies: many }));
    expect(text).toContain('종목0');
    expect(text).not.toContain(`종목${MAX_COMPANIES}`);
  });

  it('종목이 하나뿐이면 이유까지 붙인다', () => {
    const text = formatBroadcast(
      input({
        companies: [
          { name: 'HMM', stockCode: '011200', reason: '국내 최대 컨테이너 선사', direction: 'positive' },
        ],
      }),
    );
    expect(text).toContain('국내 최대 컨테이너 선사');
  });

  it('아주 긴 내용도 텔레그램 상한 안으로 자르고 링크는 남긴다', () => {
    const long = Array.from({ length: 40 }, (_, i) => ({
      step_order: i + 1,
      description: '가'.repeat(190),
    }));
    const text = formatBroadcast(input({ steps: long }));
    expect(text.length).toBeLessThanOrEqual(3500);
    // 링크가 이 글의 목적이다. 잘리면 안 된다.
    expect(text).toContain('https://eventalpha.org/events/ev-1');
    expect(text).toContain('투자 권유가 아닙니다');
  });

  it('닫히지 않은 태그를 남기지 않는다', () => {
    const long = Array.from({ length: 40 }, (_, i) => ({
      step_order: i + 1,
      description: '나'.repeat(190),
    }));
    const text = formatBroadcast(input({ steps: long }));
    const open = (text.match(/<b>/g) ?? []).length + (text.match(/<i>/g) ?? []).length;
    const close = (text.match(/<\/b>/g) ?? []).length + (text.match(/<\/i>/g) ?? []).length;
    expect(open).toBe(close);
  });
});
