import { describe, expect, it } from 'vitest';
import { MAX_COMPANIES_PER_TERM, findBroadTerms } from '@/lib/matching/candidates';

/** 키워드 하나가 기업 n개에 걸린 상황을 만든다. */
function hits(keyword: string, count: number, prefix = keyword) {
  return Array.from({ length: count }, (_, i) => ({ companyId: `${prefix}-${i}`, keyword }));
}

describe('findBroadTerms', () => {
  it('실측 사례를 기준으로 갈린다 — 타이어 3 / 철강 14 는 남고 반도체 72 는 버려진다', () => {
    const broad = findBroadTerms([
      ...hits('타이어', 3),
      ...hits('철강', 14),
      ...hits('반도체', 72),
    ]);
    expect(broad).toEqual(new Set(['반도체']));
  });

  it('상한과 정확히 같으면 남기고, 하나 더 넘으면 버린다', () => {
    expect(findBroadTerms(hits('경계', MAX_COMPANIES_PER_TERM)).size).toBe(0);
    expect(findBroadTerms(hits('경계', MAX_COMPANIES_PER_TERM + 1))).toEqual(new Set(['경계']));
  });

  it('같은 기업이 여러 번 걸려도 기업 수로 센다 — 노출 건수가 아니다', () => {
    // 한 기업이 exposure 를 100개 갖고 있어도 그 키워드는 광범위한 게 아니다.
    const many = Array.from({ length: 100 }, () => ({ companyId: '한종목', keyword: '틈새' }));
    expect(findBroadTerms(many).size).toBe(0);
  });

  it('광범위 키워드는 버려도 좁은 키워드는 남는다 — 기업이 아니라 키워드를 버린다', () => {
    const broad = findBroadTerms([
      ...hits('반도체', 72, '소부장'),
      // 같은 기업 하나가 더 좁은 키워드로도 걸린 경우
      { companyId: '소부장-0', keyword: '메모리 반도체' },
    ]);
    expect(broad.has('반도체')).toBe(true);
    expect(broad.has('메모리 반도체')).toBe(false);
  });

  it('빈 입력에서 터지지 않는다', () => {
    expect(findBroadTerms([])).toEqual(new Set());
  });
});
