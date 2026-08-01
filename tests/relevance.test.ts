import { describe, expect, it } from 'vitest';
import { judgeEconomic } from '@/lib/news/relevance';

/**
 * 회귀 기준은 실제로 수집돼서 화면까지 올라갔던 기사들이다.
 * 경제 키워드로 검색했는데 날씨·수의학 기사가 딸려 왔다.
 */

describe('judgeEconomic — 실측 오염 기사 차단', () => {
  const junk = [
    'DKA로 악화된 고양이 당뇨 “환자 안정화가 핵심”',
    '여름철 높아지는 ‘급성콩팥손상’ 위험 [헬스]',
    '이재호 연수구청장 “민선 9기, 연수구 황금기 완성…성과로 증명할 것”',
    '강원소방, 폭염 장기화에 화재 예방순찰 강화',
    '양산 최고기온 경신.. 폭염 속 정전 잇따라',
    '[내일의 날씨] 남부 최고 39도·열대야 이어져…폭염중대경보',
    '41도 넘긴 폭염… 온열질환자 1,638명, 제주도 밤낮 달아올랐다',
    '인천시, 소방·해경 공조 특별 순찰 가동…여름철 수상안전 총력',
  ];

  for (const title of junk) {
    it(`차단: ${title.slice(0, 28)}`, () => {
      expect(judgeEconomic(title).economic).toBe(false);
    });
  }
});

describe('judgeEconomic — 경제 기사 통과', () => {
  const keep = [
    '韓·아르헨, 핵심광물 MOU 체결…내년부터 원유 수입 본격화',
    '어닝 서프라이즈인데 목표가는 싹둑? 삼성SDI 흑자전환의 속사정',
    '밀린 물량이 온다…LG에너지솔루션, 수주 확대에 실적 회복 시동',
    '호르무즈 해협 유조선 공격에 따른 원유 공급 차질 우려',
    '교보증권 "중국·인도·유럽 다 잡았다…HL만도, 빈틈없는 실적"',
    '정부, 20조원 한국판 전략형 국부펀드 도입…전략산업 장기 투자',
  ];

  for (const title of keep) {
    it(`통과: ${title.slice(0, 28)}`, () => {
      expect(judgeEconomic(title).economic).toBe(true);
    });
  }
});

describe('judgeEconomic — 경제 신호가 배제어를 이긴다', () => {
  it('폭염이 나와도 실적 기사면 통과한다', () => {
    // 배제어만 보면 막히지만, 이건 명백히 투자 기사다.
    const verdict = judgeEconomic('폭염에 전력 수요 급증…한전 3분기 영업이익 흑자전환');
    expect(verdict.economic).toBe(true);
    expect(verdict.reason).toContain('경제 신호');
  });

  it('날씨 기사에 기업 이름만 스쳐도 경제어가 없으면 막는다', () => {
    expect(judgeEconomic('불볕더위 속 정전‥ 집은 찜통, 식당은 영업 중단').economic).toBe(false);
  });
});

describe('judgeEconomic — 기본값', () => {
  it('어느 신호도 없으면 통과시킨다 — 오차단이 더 비싸다', () => {
    // 기본 차단으로 두면 "호르무즈 유조선 피격", "멈춰 선 TSMC" 같은
    // 진짜 경제 기사가 잘린다(실측 900건에서 확인). 최종 관문은 공개 단계다.
    expect(judgeEconomic('아르헨티나 리튬 염호 개발 협약 체결').economic).toBe(true);
    expect(judgeEconomic('강진 덮친 실리콘 아일랜드‥멈춰 선 TSMC').economic).toBe(true);
    expect(judgeEconomic('미국·이스라엘 이란 공습설…호르무즈 유조선 피격').economic).toBe(true);
  });

  it('실측 회귀: 지명 양산(梁山)을 量産으로 읽지 않는다', () => {
    expect(judgeEconomic('양산 최고기온 경신.. 폭염 속 정전 잇따라').economic).toBe(false);
  });

  it('빈 제목은 막는다', () => {
    expect(judgeEconomic('').economic).toBe(false);
    expect(judgeEconomic('   ').economic).toBe(false);
  });

  it('띄어쓰기가 달라도 같게 본다', () => {
    expect(judgeEconomic('최고 기온 경신').economic).toBe(false);
    expect(judgeEconomic('최고기온 경신').economic).toBe(false);
  });

  it('판정 근거를 남긴다 — 왜 걸렀는지 못 보면 규칙을 고칠 수 없다', () => {
    expect(judgeEconomic('강원소방 폭염 순찰').reason).toContain('폭염');
  });
});
