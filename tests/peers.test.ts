import { describe, expect, it } from 'vitest';
import {
  MAX_PEERS_PER_EVENT,
  MAX_PEERS_PER_TERM,
  type PeerCompany,
  type PeerExposure,
  peerScore,
  selectPeers,
} from '@/lib/matching/peers';

const 고무 = '고무제품 제조업';
const 철강 = '1차 철강 제조업';

function company(id: string, industry: string | null = 고무): PeerCompany {
  return { companyId: id, companyName: id, industryName: industry };
}

function seeds(...rows: [string, string?][]): Map<string, PeerCompany> {
  return new Map(rows.map(([id, ind]) => [id, company(id, ind ?? 고무)]));
}

function exposures(...rows: [string, string][]): PeerExposure[] {
  return rows.map(([companyId, value]) => ({
    companyId,
    normalizedValue: value,
    exposureValue: value,
  }));
}

/** 같은 업종의 보유 기업 목록 */
function holders(industry: string, ...ids: string[]): PeerCompany[] {
  return ids.map((id) => company(id, industry));
}

describe('selectPeers', () => {
  it('같은 제품 + 같은 업종이면 붙인다 — 금호타이어 → 한국타이어·넥센타이어', () => {
    const picks = selectPeers(
      seeds(['금호']),
      exposures(['금호', '타이어']),
      new Map([['타이어', holders(고무, '금호', '한국', '넥센')]]),
    );

    expect(picks.map((p) => p.companyId).sort()).toEqual(['넥센', '한국']);
    expect(picks[0].sharedTerms[0]).toMatchObject({ exposureValue: '타이어', seedName: '금호' });
  });

  it('업종이 다르면 제품이 같아도 버린다 — SK하이닉스 "컴퓨터" ↔ 사조산업', () => {
    const picks = selectPeers(
      seeds(['SK하이닉스', '반도체 제조업']),
      exposures(['SK하이닉스', '컴퓨터']),
      new Map([
        [
          '컴퓨터',
          [
            company('SK하이닉스', '반도체 제조업'),
            company('사조산업', '수산물 가공 및 저장 처리업'),
            company('하나투어', '여행사 및 기타 여행보조 서비스업'),
          ],
        ],
      ]),
    );
    expect(picks).toEqual([]);
  });

  it('업종을 모르는 씨앗으로는 확장하지 않는다', () => {
    const picks = selectPeers(
      seeds(['씨앗', undefined]).set('씨앗', company('씨앗', null)),
      exposures(['씨앗', '타이어']),
      new Map([['타이어', holders(고무, '씨앗', '한국')]]),
    );
    expect(picks).toEqual([]);
  });

  it('업종을 모르는 후보는 붙이지 않는다', () => {
    const picks = selectPeers(
      seeds(['금호']),
      exposures(['금호', '타이어']),
      new Map([['타이어', [company('금호', 고무), company('미상', null)]]]),
    );
    expect(picks).toEqual([]);
  });

  it('씨앗 자신은 다시 붙지 않는다', () => {
    const picks = selectPeers(
      seeds(['금호']),
      exposures(['금호', '타이어']),
      new Map([['타이어', holders(고무, '금호')]]),
    );
    expect(picks).toEqual([]);
  });

  it('변별력 없는 용어는 통째로 버린다 — "자동차부품" 44개는 확장 근거가 못 된다', () => {
    const ids = Array.from({ length: 44 }, (_, i) => `c${i}`);
    const picks = selectPeers(
      seeds(['c0', 철강]),
      exposures(['c0', '자동차부품']),
      new Map([['자동차부품', holders(철강, ...ids)]]),
    );
    expect(picks).toEqual([]);
  });

  it('용어 상한과 같으면 통과한다 — 경계에서 조용히 사라지지 않게', () => {
    // 이벤트 상한(12)이 용어 상한(15)보다 작아 결과를 가리므로 여기서만 풀어둔다.
    const ids = Array.from({ length: MAX_PEERS_PER_TERM }, (_, i) => `c${i}`);
    const picks = selectPeers(
      seeds(['c0', 철강]),
      exposures(['c0', '특수강']),
      new Map([['특수강', holders(철강, ...ids)]]),
      { maxPeers: 100 },
    );
    expect(picks.length).toBe(MAX_PEERS_PER_TERM - 1);

    // 하나만 더 넘으면 용어째로 버려진다.
    expect(
      selectPeers(
        seeds(['c0', 철강]),
        exposures(['c0', '특수강']),
        new Map([['특수강', holders(철강, ...ids, 'c99')]]),
        { maxPeers: 100 },
      ),
    ).toEqual([]);
  });

  it('넓은 용어는 버리고 좁은 용어는 살린다 — 같은 씨앗의 다른 제품', () => {
    const broad = Array.from({ length: 30 }, (_, i) => `broad${i}`);
    const picks = selectPeers(
      seeds(['씨앗', 철강]),
      exposures(['씨앗', '수출입'], ['씨앗', '후판']),
      new Map([
        ['수출입', holders(철강, '씨앗', ...broad)],
        ['후판', holders(철강, '씨앗', '동국제강')],
      ]),
    );
    expect(picks.map((p) => p.companyId)).toEqual(['동국제강']);
  });

  it('이미 붙어 있는 종목은 건드리지 않는다', () => {
    const picks = selectPeers(
      seeds(['금호']),
      exposures(['금호', '타이어']),
      new Map([['타이어', holders(고무, '금호', '한국', '넥센')]]),
      { exclude: new Set(['한국']) },
    );
    expect(picks.map((p) => p.companyId)).toEqual(['넥센']);
  });

  it('겹치는 제품이 많은 종목을 앞에 둔다', () => {
    const picks = selectPeers(
      seeds(['씨앗', 철강]),
      exposures(['씨앗', '후판'], ['씨앗', '철근']),
      new Map([
        ['후판', holders(철강, '씨앗', '둘다', '하나만')],
        ['철근', holders(철강, '씨앗', '둘다')],
      ]),
    );
    expect(picks.map((p) => p.companyId)).toEqual(['둘다', '하나만']);
    expect(picks[0].sharedTerms).toHaveLength(2);
  });

  it('이벤트당 상한을 넘지 않는다', () => {
    const seedMap = new Map<string, PeerCompany>();
    const seedExposures: PeerExposure[] = [];
    const byTerm = new Map<string, PeerCompany[]>();
    // 씨앗 5개 × 용어당 기업 10개 = 상한을 넘는 후보를 만든다.
    for (let s = 0; s < 5; s++) {
      seedMap.set(`seed${s}`, company(`seed${s}`, 철강));
      seedExposures.push({ companyId: `seed${s}`, normalizedValue: `제품${s}`, exposureValue: `제품${s}` });
      byTerm.set(`제품${s}`, holders(철강, `seed${s}`, ...Array.from({ length: 9 }, (_, i) => `peer${s}_${i}`)));
    }
    expect(selectPeers(seedMap, seedExposures, byTerm).length).toBe(MAX_PEERS_PER_EVENT);
  });

  it('한 글자 용어는 쓰지 않는다', () => {
    const picks = selectPeers(
      seeds(['씨앗', 철강]),
      exposures(['씨앗', '강']),
      new Map([['강', holders(철강, '씨앗', '다른회사')]]),
    );
    expect(picks).toEqual([]);
  });
});

describe('peerScore', () => {
  it('기사 직접 언급(본문 45)보다 항상 낮다 — 근거가 약한 종목이 위로 올라오면 안 된다', () => {
    for (const n of [1, 2, 3, 10]) expect(peerScore(n)).toBeLessThan(45);
  });

  it('공개 하한(20)보다는 높다 — 화면에서 사라지면 만드는 의미가 없다', () => {
    expect(peerScore(1)).toBeGreaterThan(20);
  });

  it('겹치는 제품이 많을수록 높다', () => {
    expect(peerScore(2)).toBeGreaterThan(peerScore(1));
    expect(peerScore(3)).toBeGreaterThan(peerScore(2));
  });
});
