/**
 * 동종 확장 — 이미 이벤트에 붙은 종목과 **같은 주요제품을 파는 상장사**를 찾는다.
 *
 * 존재 이유는 "금호타이어가 영향받으면 한국타이어·넥센타이어도 받는다"를 화면에
 * 반영하기 위해서다. 기사가 한 종목만 언급해도 같은 제품군은 같은 변수를 맞는다.
 * 이건 문자열 매칭이 아니라 관계 추론이지만, LLM 없이 노출 데이터만으로 결정된다.
 *
 * 지금 쓸 수 있는 관계가 "같은 주요제품" 하나뿐인 것은 데이터 제약이다.
 * company_exposures 7,100건 중 product 가 7,100건이고 customer/supplier/competitor 는
 * 44건뿐이다(build_profiles 를 돌린 2개 회사분). 공급망 데이터가 쌓이면
 * 같은 자리에 supplier/customer hop 을 추가하면 된다.
 */

/** 한 제품 용어가 끌고 올 수 있는 기업 수 상한. candidates.ts 의 것과 같은 취지다. */
export const MAX_PEERS_PER_TERM = 15;

/** 이벤트 하나에 동종 확장으로 붙일 수 있는 종목 수 상한. */
export const MAX_PEERS_PER_EVENT = 12;

/** 이보다 짧은 용어는 변별력이 없다고 보고 쓰지 않는다. */
const MIN_TERM_LENGTH = 2;

export type PeerExposure = {
  companyId: string;
  /** 정규화된 제품명 — 매칭 키 */
  normalizedValue: string;
  /** 원문 표기 — 화면에 그대로 쓴다 */
  exposureValue: string;
};

export type PeerCompany = {
  companyId: string;
  companyName: string;
  /** KRX 업종. 같은 제품이라도 업종이 다르면 동종이 아니다 (아래 주석 참고) */
  industryName: string | null;
};

export type SharedTerm = {
  normalizedValue: string;
  exposureValue: string;
  /** 이 용어를 공유하는 씨앗 종목 이름 */
  seedName: string;
};

export type PeerPick = {
  companyId: string;
  /** 왜 걸렸는지. 여러 용어로 걸리면 전부 남긴다. */
  sharedTerms: SharedTerm[];
};

export type SelectPeersOptions = {
  maxPerTerm?: number;
  maxPeers?: number;
  /** 이미 이벤트에 붙어 있어 건드리면 안 되는 종목 */
  exclude?: Set<string>;
};

/**
 * 씨앗 종목들의 제품을 공유하면서 **업종까지 같은** 다른 상장사를 고른다.
 *
 * 업종 일치를 요구하는 이유는 KRX 주요제품이 자유기술 필드이기 때문이다.
 * 복합기업은 목록 끝에 "통신", "컴퓨터" 같은 일반어를 달아둔다. 실측 오탐:
 *   SK하이닉스 "컴퓨터" ↔ 사조산업(참치·명태·오징어·…·컴퓨터)
 *   삼성전자 "통신"   ↔ 하나투어, CJ제일제당
 * 이런 용어는 보유 기업이 6~10개라 개수 상한(15)을 통과해버린다.
 * 업종을 같이 보면 전부 걸러진다 — 반도체 제조업 ↔ 수산물 가공업.
 *
 * **대가를 알고 택한 것이다.** 업종 표기가 갈리는 맞는 짝도 같이 떨어진다:
 * 메디톡스(기초 의약물질 제조업) ↔ 화일약품(의약품 제조업)은 "의약품원료"를
 * 공유하는 진짜 동종인데 차단된다. 사조산업이 SK하이닉스 옆에 뜨는 쪽이
 * 제품 신뢰에 훨씬 치명적이라 정확도를 택했다.
 *
 * @param seeds           씨앗 종목 id → 종목 정보
 * @param seedExposures   씨앗 종목들의 제품 노출
 * @param companiesByTerm 정규화 제품명 → 그 제품을 가진 전체 상장사
 */
export function selectPeers(
  seeds: Map<string, PeerCompany>,
  seedExposures: PeerExposure[],
  companiesByTerm: Map<string, PeerCompany[]>,
  options: SelectPeersOptions = {},
): PeerPick[] {
  const maxPerTerm = options.maxPerTerm ?? MAX_PEERS_PER_TERM;
  const maxPeers = options.maxPeers ?? MAX_PEERS_PER_EVENT;
  const exclude = options.exclude ?? new Set<string>();

  const picks = new Map<string, PeerPick>();

  for (const exposure of seedExposures) {
    const term = exposure.normalizedValue;
    if (term.length < MIN_TERM_LENGTH) continue;

    const holders = companiesByTerm.get(term);
    if (!holders) continue;

    // 변별력 검사는 씨앗을 포함한 전체 보유 기업 수로 한다.
    // "자동차부품 44개"는 씨앗을 빼도 여전히 변별력이 없다.
    if (holders.length > maxPerTerm) continue;

    const seed = seeds.get(exposure.companyId);
    // 업종을 모르는 씨앗으로는 확장하지 않는다. 확인할 방법이 없다.
    if (!seed?.industryName) continue;

    for (const holder of holders) {
      // 씨앗 자신과 이미 붙어 있는 종목은 건너뛴다.
      if (seeds.has(holder.companyId) || exclude.has(holder.companyId)) continue;
      if (holder.industryName !== seed.industryName) continue;

      let pick = picks.get(holder.companyId);
      if (!pick) picks.set(holder.companyId, (pick = { companyId: holder.companyId, sharedTerms: [] }));
      if (pick.sharedTerms.some((t) => t.normalizedValue === term)) continue;
      pick.sharedTerms.push({
        normalizedValue: term,
        exposureValue: exposure.exposureValue,
        seedName: seed.companyName,
      });
    }
  }

  // 겹치는 제품이 많을수록 관련성이 높다.
  return Array.from(picks.values())
    .sort((a, b) => b.sharedTerms.length - a.sharedTerms.length)
    .slice(0, maxPeers);
}

/**
 * 동종 확장으로 받는 점수.
 *
 * 기사 직접 언급(제목 60 / 본문 45)보다 반드시 낮아야 한다. 근거가
 * "같은 제품을 판다" 하나뿐이라 언급된 종목과 같은 줄에 세우면 과장이 된다.
 * 겹치는 제품이 여러 개면 조금 올린다.
 */
export const PEER_BASE_SCORE = 30;

export function peerScore(sharedTerms: number): number {
  if (sharedTerms >= 3) return 38;
  if (sharedTerms === 2) return 34;
  return PEER_BASE_SCORE;
}
