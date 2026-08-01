import type { ExposureType, RelationType, VariableDirection } from '@/lib/db/enums';

/** 후보 생성 단계에서 어떤 경로로 매칭됐는지 */
export type MatchKind = 'exact' | 'synonym' | 'fulltext' | 'embedding' | 'relation';

export type MatchedExposure = {
  id: string;
  exposureType: ExposureType;
  exposureValue: string;
  normalizedValue: string;
  revenueShare: number | null;
  geography: string | null;
  direction: VariableDirection | null;
  verified: boolean;
  evidenceId: string | null;
  evidenceSourceType: 'dart' | 'news' | 'company_ir' | 'exchange' | 'manual' | null;
  evidenceVerified: boolean;
  /** 이 exposure 가 매칭된 방식 */
  matchKind: MatchKind;
  /** 임베딩 매칭일 때의 코사인 유사도 */
  similarity: number | null;
  /** 매칭에 사용된 이벤트 측 키워드 */
  matchedKeyword: string;
  /**
   * 이 키워드가 이번 검색에서 끌고 온 기업 수. **용어의 변별력**이다.
   *
   * 실측(제품 노출 7,100건 / 고유 용어 5,348개): 86%인 4,615개 용어는 회사가 하나뿐이라
   * 종목을 정확히 특정한다. 반대로 "반도체" 26개사 · "지주회사" 33개사 · "부동산 임대"
   * 54개사 같은 용어는 아무 회사도 특정하지 못한다. 그런데 0009 까지는 둘이 **같은 점수**를
   * 받았다 — "단어가 겹친다"를 "관련이 있다"로 셈한 것이다.
   */
  termCompanyCount: number;
};

export type Candidate = {
  companyId: string;
  companyName: string;
  stockCode: string | null;
  market: string | null;
  industryName: string | null;
  latestReportDate: string | null;
  /**
   * 이 기업이 파는 제품의 총 가짓수 (companies.product_exposure_count).
   *
   * exposures 는 **매칭된 것만** 담고 있어서 이 값 없이는 "12개 중 1개가 걸렸다"와
   * "1개 중 1개가 걸렸다"를 구분할 수 없다. 집중도 점수의 분모다.
   */
  productExposureCount: number;
  exposures: MatchedExposure[];
};

/** 이벤트에서 뽑아낸 검색 조건 */
export type EventQuery = {
  industries: string[];
  products: string[];
  rawMaterials: string[];
  customerGroups: string[];
  geography: string[];
};

export type ScoreBreakdown = {
  product: number;
  revenue: number;
  geography: number;
  supplyChain: number;
  disclosure: number;
  recency: number;
  thematic: number;
  /** 사업 집중도. 매칭이 그 회사의 몇 분의 몇인가 (0009) */
  focus?: number;
  /** 업종이 이벤트가 건드리는 산업과 맞는가 (0009) */
  industry?: number;
  /** 기사 직접 언급 점수. scoreCandidate 는 채우지 않는다 (lib/events/mentions.ts 전용) */
  mention?: number;
  /** 동종 확장 점수. scoreCandidate 는 채우지 않는다 (lib/events/peers.ts 전용) */
  peer?: number;
  total: number;
  notes: string[];
};

export type ScoredCandidate = {
  candidate: Candidate;
  breakdown: ScoreBreakdown;
  /** 하드 룰 적용 후 최종 관계 유형 상한 */
  forcedRelationType: RelationType | null;
};
