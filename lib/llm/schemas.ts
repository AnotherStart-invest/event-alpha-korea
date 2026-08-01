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
 * 핵심 설계: **LLM 이 무엇을 말하든 코드가 실존을 검증한다.**
 * P3 의 company_id 는 코드가 준 후보 목록 안의 값인지, P5 의 companies[].name 은
 * 상장사 사전에 해석되는지 사후 검증한다. 프롬프트가 아니라 타입과 집합 검증으로
 * 강제하는 것이 요점이다 — 그래서 없는 종목이 화면에 뜨는 일은 불가능하다.
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
 * companies 필드로 **회사 이름을 제안할 수 있다.** 다만 lib/matching/resolve.ts 가
 * 상장사 사전에 대조해 해석되지 않는 이름은 버린다. 아래 필드 주석 참고.
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
  /**
   * 이 단계에 해당하는 **국내 상장사 이름**.
   *
   * ⚠️ 이 필드는 원래 없었다. "LLM 은 기업명을 출력할 수 없다" 가 이 시스템의
   * 불변식이었고, 종목은 KRX 주요제품 문자열 매칭으로만 찾았다. 그런데 그 다리가
   * 품질의 상한이었다 — "소프트웨어 개발"(13개사) 하나로 넷마블과 셀바스AI가 같이
   * 걸리고, 밸류체인의 전·후방은 문자열로 이을 방법이 아예 없었다.
   *
   * 불변식을 이렇게 바꿨다: **LLM 은 제안하고, 코드가 실존을 검증한다.**
   * 여기 적힌 이름은 lib/matching/resolve.ts 가 상장사 사전에 대조하고,
   * 해석되지 않으면 버린다. 그래서 없는 종목이 화면에 뜨는 일은 여전히 불가능하다.
   */
  companies: z
    .array(
      z.object({
        /** 상장사 이름. 종목코드나 외국 기업은 쓰지 않는다. */
        name: z.string().min(2).max(30),
        /** 왜 이 회사인지. 사업 구조로 설명한다. */
        reason: z.string().min(10).max(200),
      }),
    )
    .max(5)
    // LLM 이 확실한 회사를 못 대면 생략할 수 있어야 한다.
    // 필수로 두면 억지로 채우게 되고, 그게 정확히 우리가 막으려는 행동이다.
    .default([]),
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
