import { describe, expect, it } from 'vitest';
import {
  AMBIGUOUS_NAMES,
  MIN_NAME_LENGTH,
  buildMentionDict,
  findMentions,
  normalizeWithOrigin,
  type MentionCompany,
} from '@/lib/matching/mentions';

/**
 * 직접 언급 매칭은 LLM 을 안 쓰는 대신 문자열 규칙에 전부 걸려 있다.
 * 규칙이 무너지면 "AI 가 종목을 지어낸다" 와 같은 결과가 되므로
 * 오탐 케이스를 여기 고정한다.
 */

function company(name: string, stockCode: string): MentionCompany {
  return {
    companyId: `id-${stockCode}`,
    companyName: name,
    stockCode,
    market: 'KOSPI',
    industryName: null,
    latestReportDate: null,
  };
}

const dict = buildMentionDict([
  company('삼성전자', '005930'),
  company('삼성SDI', '006400'),
  company('LG에너지솔루션', '373220'),
  company('SK하이닉스', '000660'),
  company('대한항공', '003490'),
  company('현대자동차', '005380'),
  company('한국타이어앤테크놀로지', '161390'),
  company('금호타이어', '073240'),
  company('HL만도', '204320'),
  company('한국전력공사', '015760'),
  company('기아', '000270'),
  company('SK증권', '001510'),
  company('NH투자증권', '005940'),
  company('LG전자', '066570'),
]);

const names = (text: string, description?: string) =>
  findMentions(dict, { title: text, description })
    .map((m) => m.company.companyName)
    .sort();

describe('직접 언급 매칭', () => {
  it('제목에 그대로 나온 이름을 잡는다', () => {
    expect(names('삼성SDI, 실적 개선 속 해외 수주 가속화할까')).toEqual(['삼성SDI']);
    expect(names("HL만도, 중국 매출 10% 증가 … '차이나 스피드' 맞춤형 대응")).toEqual(['HL만도']);
  });

  it('조사가 붙어도 잡는다', () => {
    expect(names('삼성전자가 3분기 실적을 발표했다')).toEqual(['삼성전자']);
    expect(names('LG에너지솔루션의 ESS 수주가 늘었다')).toEqual(['LG에너지솔루션']);
    expect(names('SK하이닉스와 삼성전자는 나란히')).toEqual(['SK하이닉스', '삼성전자']);
  });

  it('공백이 끼어 있어도 잡는다', () => {
    expect(names('삼성 SDI 흑자전환')).toEqual(['삼성SDI']);
  });

  it('조사가 아닌 한글이 이어지면 버린다 — 공백 제거의 부작용을 막는 핵심 규칙', () => {
    // "대한 항공사" 는 정규화하면 "대한항공사" 가 되어 대한항공을 삼킨다.
    expect(names('대한 항공사들이 국제선을 늘린다')).toEqual([]);
    // 현대차그룹은 현대자동차와 다른 대상이다.
    expect(names('현대차그룹 지배구조 개편')).toEqual([]);
  });

  it('긴 이름을 먼저 잡는다', () => {
    expect(names('한국타이어앤테크놀로지, 유럽 공장 증설')).toEqual(['한국타이어앤테크놀로지']);
  });

  it('약칭 사전이 동작한다', () => {
    expect(names('현대차, 미국 관세 영향 점검')).toEqual(['현대자동차']);
    expect(names('한전 적자 축소')).toEqual(['한국전력공사']);
  });

  it('본문 언급과 제목 언급을 구분한다', () => {
    const found = findMentions(dict, {
      title: '배터리 3사 나란히 흑자전환',
      description: '삼성SDI와 LG에너지솔루션이 나란히 흑자로 돌아섰다.',
    });
    expect(found.every((m) => !m.inTitle)).toBe(true);
    expect(found.map((m) => m.company.companyName).sort()).toEqual(['LG에너지솔루션', '삼성SDI']);
  });

  it('같은 회사가 제목과 본문에 다 나오면 제목 쪽을 남긴다', () => {
    const found = findMentions(dict, {
      title: '삼성SDI 흑자전환',
      description: '삼성SDI의 2분기 영업이익이…',
    });
    expect(found).toHaveLength(1);
    expect(found[0].inTitle).toBe(true);
  });

  it('근거로 쓸 원문 발췌를 남긴다', () => {
    const [found] = findMentions(dict, { title: '삼성SDI, 실적 개선 속 해외 수주 가속화할까' });
    expect(found.matchedText).toBe('삼성SDI');
    expect(found.excerpt).toContain('삼성SDI');
  });

  it('짧은 이름은 사전에 넣지 않는다', () => {
    // 기아(2자)는 MIN_NAME_LENGTH 미만이라 제외된다.
    expect(MIN_NAME_LENGTH).toBe(3);
    expect(names('기아, 3분기 판매 증가')).toEqual([]);
  });

  it('같은 표기를 두 회사가 쓰면 둘 다 버린다', () => {
    const collide = buildMentionDict([company('동일기업', '111111'), company('동일기업', '222222')]);
    expect(collide.byKey.size).toBe(0);
  });

  it('일반명사로 더 자주 쓰이는 이름은 사전에서 뺀다', () => {
    const risky = buildMentionDict([company('한국전자', '999999')]);
    expect(risky.byKey.size).toBe(0);
    expect(AMBIGUOUS_NAMES.size).toBeGreaterThan(0);
  });

  it('언급이 없으면 빈 결과를 준다', () => {
    expect(names('정부, 내일부터 마약 특별단속')).toEqual([]);
  });

  it('논평 주체로 나온 증권사는 뺀다', () => {
    // 실제 수집된 기사 제목이다. 관련 종목은 LG전자지 SK증권이 아니다.
    expect(names('SK증권 "LG전자, 전 사업부가 연초 예상보다 양호한 실적"')).toEqual(['LG전자']);
    expect(names('삼성SDI, 실적 개선 속 해외 수주 가속화할까', '주민우 NH투자증권 애널리스트는')).toEqual([
      '삼성SDI',
    ]);
  });

  it('증권사가 기사의 대상이면 남긴다', () => {
    expect(names('SK증권, 유상증자 결의')).toEqual(['SK증권']);
  });
});

describe('원문 위치 보존 정규화', () => {
  it('정규화 문자열의 각 글자가 원문 위치를 가리킨다', () => {
    const { norm, origin } = normalizeWithOrigin('삼성 SDI, 실적');
    expect(norm).toBe('삼성sdi실적');
    expect(origin).toHaveLength(norm.length);
    expect('삼성 SDI, 실적'[origin[2]]).toBe('S');
  });
});
