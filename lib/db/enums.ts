/**
 * DB enum 의 단일 진실 공급원.
 * Postgres enum(DATABASE_SCHEMA §1)과 반드시 일치해야 하며,
 * tests/enums.test.ts 가 Zod 스키마와의 정합성을 검사한다.
 */

export const MARKETS = ['KOSPI', 'KOSDAQ', 'KONEX'] as const;
export type Market = (typeof MARKETS)[number];

export const VERIFICATION_STATUSES = ['unverified', 'auto', 'reviewed', 'rejected'] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

export const EVENT_TYPES = [
  'policy_regulation',
  'tariff_trade',
  'commodity_price',
  'supply_disruption',
  'production_halt',
  'major_order',
  'contract_change',
  'ma_control',
  'asset_sale',
  'geopolitics_logistics',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const EVENT_TYPE_LABELS: Record<EventType, string> = {
  policy_regulation: '정책·규제',
  tariff_trade: '관세·수출입',
  commodity_price: '원자재 가격',
  supply_disruption: '공급망 중단',
  production_halt: '생산 중단',
  major_order: '대규모 수주',
  contract_change: '계약 체결·해지',
  ma_control: 'M&A·경영권',
  asset_sale: '자산 매각',
  geopolitics_logistics: '지정학·운송',
};

export const EVENT_STATUSES = [
  'candidate',
  'analyzing',
  'analyzed',
  'pending_review',
  'published',
  'rejected',
  'failed',
] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

export const EVENT_STATUS_LABELS: Record<EventStatus, string> = {
  candidate: '수집됨',
  analyzing: '분석 중',
  analyzed: '분석 완료',
  pending_review: '검수 대기',
  published: '공개됨',
  rejected: '반려됨',
  failed: '분석 실패',
};

export const TIME_HORIZONS = ['immediate', 'short', 'mid', 'long', 'unknown'] as const;
export type TimeHorizon = (typeof TIME_HORIZONS)[number];

export const TIME_HORIZON_LABELS: Record<TimeHorizon, string> = {
  immediate: '즉시',
  short: '단기 (1~3개월)',
  mid: '중기 (3~12개월)',
  long: '장기 (1년 이상)',
  unknown: '불명확',
};

export const VARIABLE_DIRECTIONS = ['up', 'down', 'mixed', 'unknown'] as const;
export type VariableDirection = (typeof VARIABLE_DIRECTIONS)[number];

export const IMPACT_DIRECTIONS = ['positive', 'negative', 'mixed', 'uncertain'] as const;
export type ImpactDirection = (typeof IMPACT_DIRECTIONS)[number];

export const IMPACT_DIRECTION_LABELS: Record<ImpactDirection, string> = {
  positive: '긍정 영향 가능성',
  negative: '부정 영향 가능성',
  mixed: '혼재',
  uncertain: '불확실',
};

export const IMPACT_LEVELS = ['high', 'medium', 'low'] as const;
export type ImpactLevel = (typeof IMPACT_LEVELS)[number];

export const IMPACT_LEVEL_LABELS: Record<ImpactLevel, string> = {
  high: '높음',
  medium: '중간',
  low: '낮음',
};

export const RELATION_TYPES = [
  'direct',
  'indirect',
  'supply_chain',
  'competitor',
  'substitute',
  'thematic',
] as const;
export type RelationType = (typeof RELATION_TYPES)[number];

export const RELATION_TYPE_LABELS: Record<RelationType, string> = {
  direct: '직접',
  indirect: '간접',
  supply_chain: '공급망',
  competitor: '경쟁관계',
  substitute: '대체재',
  thematic: '단순 테마',
};

export const REVIEW_STATUSES = ['pending', 'approved', 'rejected', 'edited'] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export const EXPOSURE_TYPES = [
  'product',
  'raw_material',
  'customer',
  'customer_industry',
  'geography',
  'supplier',
  'subsidiary',
  'project',
  'policy',
  'commodity',
  'competitor',
  'substitute',
  'positive_variable',
  'negative_variable',
] as const;
export type ExposureType = (typeof EXPOSURE_TYPES)[number];

export const EXPOSURE_TYPE_LABELS: Record<ExposureType, string> = {
  product: '제품·서비스',
  raw_material: '원재료',
  customer: '고객사',
  customer_industry: '고객 산업',
  geography: '지역',
  supplier: '공급사',
  subsidiary: '자회사',
  project: '주요 프로젝트',
  policy: '정책 노출',
  commodity: '원자재 노출',
  competitor: '경쟁사',
  substitute: '대체재',
  positive_variable: '긍정 민감 변수',
  negative_variable: '부정 민감 변수',
};

export const EVIDENCE_SOURCE_TYPES = ['dart', 'news', 'company_ir', 'exchange', 'manual'] as const;
export type EvidenceSourceType = (typeof EVIDENCE_SOURCE_TYPES)[number];

export const EVIDENCE_SOURCE_LABELS: Record<EvidenceSourceType, string> = {
  dart: '전자공시',
  news: '뉴스',
  company_ir: '기업 IR',
  exchange: '거래소',
  manual: '수기 입력',
};

export const PROCESSING_STATUSES = ['pending', 'clustered', 'skipped', 'failed'] as const;
export type ProcessingStatus = (typeof PROCESSING_STATUSES)[number];

export const REQUIREMENT_TYPES = [
  'evidence_to_check',
  'invalidation_condition',
  'follow_up_event',
] as const;
export type RequirementType = (typeof REQUIREMENT_TYPES)[number];

export const REQUIREMENT_TYPE_LABELS: Record<RequirementType, string> = {
  evidence_to_check: '확인해야 할 숫자',
  invalidation_condition: '가설이 틀리는 조건',
  follow_up_event: '후속 이벤트',
};
