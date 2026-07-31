import { describe, expect, it } from 'vitest';
import {
  containsBannedPhrase,
  findBannedPhrases,
  scanObjectForBanned,
} from '@/lib/shared/banned-words';

describe('금지 표현 린트', () => {
  it('허용 표현은 통과시킨다', () => {
    expect(containsBannedPhrase('관세 인상으로 긍정 영향 가능성이 있습니다.')).toBe(false);
    expect(containsBannedPhrase('확인해야 할 변수는 북미 매출 비중입니다.')).toBe(false);
    expect(containsBannedPhrase(null)).toBe(false);
    expect(containsBannedPhrase('')).toBe(false);
  });

  it('직접적인 투자 권유를 잡아낸다', () => {
    expect(containsBannedPhrase('지금 매수 타이밍입니다')).toBe(true);
    expect(containsBannedPhrase('목표주가 12만원')).toBe(true);
    expect(containsBannedPhrase('이 종목은 유망주입니다')).toBe(true);
  });

  it('공백 변형을 흡수한다', () => {
    expect(containsBannedPhrase('목표  주가를 제시한다')).toBe(true);
    expect(containsBannedPhrase('적정   매수가')).toBe(true);
  });

  it('검출된 표현 목록을 돌려준다', () => {
    const hits = findBannedPhrases('목표주가와 손절가를 함께 제시');
    expect(hits.map((h) => h.phrase).sort()).toEqual(['목표주가', '손절가']);
  });

  it('중첩 객체의 모든 문자열을 검사한다', () => {
    const payload = {
      rationale: '북미 매출 비중이 높아 긍정 영향 가능성',
      steps: ['관세 인상', '경쟁력 저하'],
      nested: { note: '급등 예상' },
    };
    const hits = scanObjectForBanned(payload);
    expect(hits).toHaveLength(1);
    expect(hits[0].phrase).toBe('급등 예상');
    expect(hits[0].path).toBe('$.nested.note');
  });
});
