import { z } from 'zod';
import {
  EVENT_TYPES,
  IMPACT_DIRECTIONS,
  IMPACT_LEVELS,
  RELATION_TYPES,
  TIME_HORIZONS,
  VARIABLE_DIRECTIONS,
} from '@/lib/db/enums';

/**
 * LLM structured output 스키마 (LLM_PROMPTS.md P1~P4).
 *
 * 핵심 설계: **기업명을 출력할 수 있는 필드를 두지 않는다.**
 * P3 만 예외적으로 company_id 를 받되, 그것도 코드가 준 후보 목록 안의 값인지
 * 사후 검증한다. 프롬프트가 아니라 타입과 집합 검증으로 강제하는 것이 요점이다.
 */

const shortText = z.string().max(200);

/* ── P1. 투자 관련성 사전필터 ─────────────────────────── */

export const prefilterSchema = z.object({
  is_investment_relevant: z.boolean(),
  event_type: z.enum(EVENT_TYPES).nullable(),
  confidence: z.number().int().min(0).max(100),
  reason: shortText,
});
export type PrefilterResult = z.infer<typeof prefilterSchema>;

/* ── P2. 이벤트 구조화 ────────────────────────────────── */

const keyword = z.string().min(1).max(40);

export const eventStructureSchema = z.object({
  is_investment_relevant: z.boolean(),
  event_title: z.string().min(5).max(120),
  factual_summary: z.string().max(600),
  event_type: z.enum(EVENT_TYPES),
  primary_variable: z.string().max(120),
  variable_direction: z.enum(VARIABLE_DIRECTIONS),
  geography: z.array(keyword).max(8),
  affected_industries: z.array(keyword).max(10),
  affected_products: z.array(keyword).max(15),
  affected_raw_materials: z.array(keyword).max(10),
  affected_customer_groups: z.array(keyword).max(10),
  transmission_chain: z.array(z.string().min(5).max(200)).min(2).max(6),
  time_horizon: z.enum(TIME_HORIZONS),
  required_evidence: z.array(z.string().max(120)).max(10),
  invalidation_conditions: z.array(z.string().max(160)).max(8),
  follow_up_events: z.array(z.string().max(120)).max(8),
  event_confidence: z.number().int().min(0).max(100),
  novelty_score: z.number().int().min(0).max(100),
});
export type EventStructure = z.infer<typeof eventStructureSchema>;

/* ── P5. 전파 경로 → 종목 발굴 ────────────────────────── */

/**
 * 이벤트가 어떤 유형의 기업에 어떻게 전이되는지를 **단계별로** 받는다.
 *
 * P2(eventStructure)와 다른 점은 단계마다 **방향과 관계 유형**이 붙는다는 것이다.
 * 같은 이벤트라도 단계에 따라 부호가 뒤집힌다 — 철강값 하락은 철강사에 부정적이지만
 * 철강을 사는 조선·자동차에는 긍정적이다. 용어를 한 바구니에 담으면 이걸 표현할 수 없고,
 * 그래서 수요 측 종목이 화면에 아예 안 나왔다.
 *
 * 여기서도 **기업명을 출력할 수 있는 필드는 없다.** LLM 은 "무엇이 영향받는가"를
 * 산업·제품 수준으로만 말하고, 실제 종목은 코드가 DB 에서 결정론적으로 찾는다.
 */
export const transmissionStepSchema = z.object({
  /** 이 단계에서 무슨 일이 일어나는가. 한 문장. */
  step: z.string().min(5).max(200),
  /**
   * DB 검색어로 쓸 제품 용어. 일반 명사 형태.
   *
   * **이 단계에 걸리는 기업이 "파는" 것이어야 한다.** 검색은 KRX 주요제품과
   * 대조되므로, 그들이 사서 쓰는 원재료를 적으면 그 원재료를 만들어 파는
   * (방향이 정반대인) 기업이 잡힌다. 실측 사고: "배터리 원가 부담" 단계에
   * "배터리"를 적어 배터리 소재사가 negative 로 붙었다 — 같은 이벤트의
   * 다른 단계에서는 같은 회사들이 positive 였다.
   */
  affected_terms: z.array(keyword).min(1).max(6),
  /** 업종명 후보. KRX 업종 표기에 가깝게. */
  industry_terms: z.array(keyword).max(4),
  /** 이 단계에 걸리는 기업들 **입장에서의** 손익 방향 */
  direction: z.enum(IMPACT_DIRECTIONS),
  /** 이벤트와 이 기업군의 관계 */
  relation: z.enum(RELATION_TYPES),
  /** 왜 그 방향인지. 근거 문장. */
  reason: z.string().min(5).max(200),
});

export const transmissionSchema = z.object({
  /** 경제 논리로 경로를 그릴 수 없으면 false. 그럴듯하게 지어내는 것보다 낫다. */
  is_traceable: z.boolean(),
  primary_variable: z.string().max(120),
  variable_direction: z.enum(VARIABLE_DIRECTIONS),
  steps: z.array(transmissionStepSchema).max(4),
});
export type TransmissionResult = z.infer<typeof transmissionSchema>;
export type TransmissionStep = z.infer<typeof transmissionStepSchema>;

/** 후보 검색에 쓸 키워드가 하나라도 있는지 (V3 검증) */
export function hasSearchableKeywords(event: EventStructure): boolean {
  return (
    event.affected_industries.length +
      event.affected_products.length +
      event.affected_raw_materials.length +
      event.affected_customer_groups.length >
    0
  );
}

/* ── P3. 종목 영향 판정 ───────────────────────────────── */

export const impactJudgementSchema = z.object({
  company_id: z.string(),
  impact_direction: z.enum(IMPACT_DIRECTIONS),
  impact_level: z.enum(IMPACT_LEVELS),
  relation_type: z.enum(RELATION_TYPES),
  confidence_score: z.number().int().min(0).max(100),
  rationale: z.string().min(10).max(400),
  transmission_path: z.array(z.string().max(160)).max(4),
  evidence_ids: z.array(z.string()).max(6),
  missing_evidence: z.array(z.string().max(120)).max(5),
  invalidation_conditions: z.array(z.string().max(160)).max(4),
});
export type ImpactJudgement = z.infer<typeof impactJudgementSchema>;

export const impactBatchSchema = z.object({
  impacts: z.array(impactJudgementSchema).max(40),
});
export type ImpactBatch = z.infer<typeof impactBatchSchema>;

/* ── P4. 기업 프로필 구조화 (Python 배치와 형식 공유) ──── */

export const companyProfileSchema = z.object({
  business_summary: z.string().max(500),
  exposures: z
    .array(
      z.object({
        exposure_type: z.string().max(30),
        exposure_value: z.string().min(1).max(80),
        revenue_share: z.number().min(0).max(100).nullable(),
        geography: z.string().max(40).nullable(),
        direction: z.enum(VARIABLE_DIRECTIONS).nullable(),
        evidence_excerpt: z.string().max(400),
      }),
    )
    .max(60),
});
export type CompanyProfile = z.infer<typeof companyProfileSchema>;
