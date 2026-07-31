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
};

export type Candidate = {
  companyId: string;
  companyName: string;
  stockCode: string | null;
  market: string | null;
  industryName: string | null;
  latestReportDate: string | null;
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
