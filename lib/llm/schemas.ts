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
