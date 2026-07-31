import { describe, expect, it } from 'vitest';
import {
  cleanTitle,
  guessSourceName,
  jaccard,
  normalizeForHash,
  parsePubDate,
  sharedTokens,
  stripHtml,
  titleHash,
  tokenize,
} from '@/lib/news/normalize';

describe('stripHtml', () => {
  it('네이버가 붙이는 <b> 태그를 제거한다', () => {
    expect(stripHtml('미국 <b>관세</b> 인상')).toBe('미국 관세 인상');
  });

  it('HTML 엔티티를 복원한다', () => {
    expect(stripHtml('&quot;관세&quot; 인상 &amp; 규제')).toBe('"관세" 인상 & 규제');
    expect(stripHtml('&lt;속보&gt;')).toBe('<속보>');
  });
});

describe('cleanTitle', () => {
  it('머리표를 제거한다', () => {
    expect(cleanTitle('[단독] 미국, 중국산 변압기 관세 인상')).toBe(
      '미국, 중국산 변압기 관세 인상',
    );
    expect(cleanTitle('(종합) 구리 가격 급등')).toBe('구리 가격 급등');
  });

  it('머리표가 여러 개 붙어도 전부 제거한다', () => {
    expect(cleanTitle('[단독][영상] 반도체 수출 규제 강화')).toBe('반도체 수출 규제 강화');
  });

  it('매체 꼬리표를 제거한다', () => {
    expect(cleanTitle('구리 가격 급등 - 매일경제')).toBe('구리 가격 급등');
    expect(cleanTitle('리튬 공급 차질 | 한국경제')).toBe('리튬 공급 차질');
  });

  it('공백을 정규화한다', () => {
    expect(cleanTitle('  관세   인상   검토  ')).toBe('관세 인상 검토');
  });

  it('머리표가 없는 제목은 그대로 둔다', () => {
    expect(cleanTitle('삼성전자, 미국 공장 증설 발표')).toBe('삼성전자, 미국 공장 증설 발표');
  });
});

describe('titleHash — 동일 뉴스 판별', () => {
  it('같은 사건의 표기 차이를 같은 해시로 흡수한다', () => {
    const a = titleHash('[단독] 미국, 중국산 변압기 관세 인상');
    const b = titleHash('미국, 중국산 변압기 관세 인상');
    const c = titleHash('미국 중국산 변압기 관세 인상!');
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('서로 다른 사건은 다른 해시를 준다', () => {
    const tariff = titleHash('미국, 중국산 변압기 관세 인상');
    const fire = titleHash('포스코 포항제철소 화재 발생');
    expect(tariff).not.toBe(fire);
  });

  it('정규형은 문장부호와 대소문자를 제거한다', () => {
    expect(normalizeForHash('LNG 운반선, 대규모 수주!')).toBe('lng운반선대규모수주');
  });
});

describe('tokenize', () => {
  it('조사를 떼어낸다', () => {
    const tokens = tokenize('정부가 반도체에 보조금을 지급한다');
    expect(tokens).toContain('정부');
    expect(tokens).toContain('반도체');
    expect(tokens).toContain('보조금');
  });

  it('불용어를 제거한다', () => {
    const tokens = tokenize('지난 관세 인상 관련 기자 브리핑');
    expect(tokens).not.toContain('지난');
    expect(tokens).not.toContain('관련');
    expect(tokens).not.toContain('기자');
    expect(tokens).toContain('관세');
  });

  it('1글자 토큰을 버린다', () => {
    expect(tokenize('그 외 관세 인상')).not.toContain('그');
  });

  it('중복을 제거한다', () => {
    const tokens = tokenize('관세 관세 인상');
    expect(tokens.filter((t) => t === '관세')).toHaveLength(1);
  });
});

describe('jaccard / sharedTokens — 서로 다른 사건 오분류 방지', () => {
  it('같은 사건을 다룬 두 제목은 높은 유사도를 가진다', () => {
    const a = tokenize('미국, 중국산 변압기에 관세 25% 부과 검토');
    const b = tokenize('미국 정부, 중국산 변압기 관세 부과 검토');
    expect(jaccard(a, b)).toBeGreaterThan(0.4);
  });

  it('전혀 다른 사건은 낮은 유사도를 가진다', () => {
    const tariff = tokenize('미국, 중국산 변압기 관세 부과 검토');
    const fire = tokenize('포스코 포항제철소 화재로 생산 중단');
    expect(jaccard(tariff, fire)).toBeLessThan(0.1);
  });

  it('같은 산업이지만 다른 사건이면 병합 임계값을 넘지 않는다', () => {
    const a = tokenize('LG에너지솔루션, 미국 배터리 공장 증설');
    const b = tokenize('삼성SDI, 헝가리 배터리 공장 화재');
    expect(jaccard(a, b)).toBeLessThan(0.3);
  });

  it('공유 토큰을 돌려준다', () => {
    const shared = sharedTokens('미국 관세 인상 검토', '미국 정부 관세 인상 발표');
    expect(shared).toContain('미국');
    expect(shared).toContain('관세');
  });

  it('빈 배열은 0을 준다', () => {
    expect(jaccard([], ['관세'])).toBe(0);
  });
});

describe('parsePubDate', () => {
  it('RFC 1123 형식을 ISO 로 바꾼다', () => {
    expect(parsePubDate('Thu, 31 Jul 2026 05:20:00 +0900')).toBe('2026-07-30T20:20:00.000Z');
  });

  it('파싱 불가는 null', () => {
    expect(parsePubDate('언제인지 모름')).toBeNull();
  });
});

describe('guessSourceName', () => {
  it('호스트명을 추출한다', () => {
    expect(guessSourceName('https://www.mk.co.kr/news/123')).toBe('mk.co.kr');
  });

  it('빈 값과 잘못된 URL 은 null', () => {
    expect(guessSourceName(null)).toBeNull();
    expect(guessSourceName('not a url')).toBeNull();
  });
});
