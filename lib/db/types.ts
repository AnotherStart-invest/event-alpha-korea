/**
 * Supabase Database 타입.
 *
 * Supabase 프로젝트가 준비되면 아래 명령으로 재생성한다.
 *   npx supabase gen types typescript --project-id <ref> --schema public > lib/db/types.ts
 *
 * 그 전까지는 supabase/migrations 의 DDL 과 손으로 맞춘 이 파일을 사용한다.
 * DDL 을 바꾸면 이 파일도 반드시 함께 바꿀 것.
 */
import type {
  EventStatus,
  EventType,
  EvidenceSourceType,
  ExposureType,
  ImpactDirection,
  ImpactLevel,
  Market,
  ProcessingStatus,
  RelationType,
  RequirementType,
  ReviewStatus,
  TimeHorizon,
  VariableDirection,
  VerificationStatus,
} from './enums';

export type Json = string | number | boolean | null | { [k: string]: Json } | Json[];

type Timestamps = { created_at: string; updated_at: string };

/* ── 기업 ─────────────────────────────────────────────── */

export type CompanyRow = Timestamps & {
  id: string;
  corp_code: string | null;
  stock_code: string | null;
  company_name: string;
  market: Market | null;
  industry_code: string | null;
  industry_name: string | null;
  description: string | null;
  latest_report_date: string | null;
  verification_status: VerificationStatus;
  search_text: string | null;
  embedding: number[] | null;
  /**
   * 이 기업의 제품 노출 개수. 트리거가 유지한다 (0009).
   * 집중도 점수의 분모 — 12개 파는 회사의 1개 매칭과 1개 파는 회사의 1개 매칭을 가른다.
   */
  product_exposure_count: number;
  /** 시가총액(원). 억원이 아니다 (0009) */
  market_cap: number | null;
  shares_outstanding: number | null;
  close_price: number | null;
  price_updated_at: string | null;
  /** KRX 상장목록에 현재 있는가. false 는 상장폐지 껍데기 (0004) */
  is_listed: boolean;
  /** KRX 상장목록의 "주요제품" 원문 (0004) */
  main_products: string | null;
  krx_synced_at: string | null;
}

export type EvidenceSourceRow = {
  id: string;
  company_id: string | null;
  source_type: EvidenceSourceType;
  source_title: string;
  source_url: string | null;
  report_id: string | null;
  source_date: string | null;
  excerpt: string | null;
  collected_at: string;
}

export type CompanyExposureRow = Timestamps & {
  id: string;
  company_id: string;
  exposure_type: ExposureType;
  exposure_value: string;
  normalized_value: string;
  direction: VariableDirection | null;
  strength: number | null;
  revenue_share: number | null;
  geography: string | null;
  source_evidence_id: string | null;
  verified: boolean;
  embedding: number[] | null;
}

export type SynonymRow = {
  id: string;
  term: string;
  alias: string;
  category: string | null;
  created_at: string;
}

/* ── 뉴스 ─────────────────────────────────────────────── */

export type NewsArticleRow = {
  id: string;
  title: string;
  cleaned_title: string;
  description: string | null;
  source_name: string | null;
  original_url: string | null;
  naver_url: string | null;
  published_at: string;
  collected_at: string;
  query_keyword: string | null;
  title_hash: string;
  embedding: number[] | null;
  processing_status: ProcessingStatus;
  created_at: string;
}

export type WatchKeywordRow = {
  id: string;
  keyword: string;
  category: string | null;
  active: boolean;
  priority: number;
  last_run_at: string | null;
  created_at: string;
}

/* ── 이벤트 ───────────────────────────────────────────── */

export type EventRow = Timestamps & {
  id: string;
  title: string;
  factual_summary: string | null;
  event_type: EventType | null;
  status: EventStatus;
  primary_variable: string | null;
  variable_direction: VariableDirection;
  geography: string[];
  time_horizon: TimeHorizon;
  event_confidence: number | null;
  novelty_score: number | null;
  affected_industries: string[];
  affected_products: string[];
  affected_raw_materials: string[];
  affected_customer_groups: string[];
  cluster_key: string | null;
  embedding: number[] | null;
  retry_count: number;
  last_error: string | null;
  event_occurred_at: string | null;
  published_at: string | null;
  reviewed_at: string | null;
  approved_at: string | null;
  /** 전파 경로 추적을 시도한 시각. 경로를 못 그려도 채운다 (0007) */
  traced_at: string | null;
}

export type EventArticleRow = {
  event_id: string;
  article_id: string;
  is_primary: boolean;
  similarity: number | null;
}

/** 밸류체인상 위치. 단계 순서에서 도출한다 (0009) */
export type ChainPosition = 'upstream' | 'midstream' | 'downstream';

export type EventTransmissionStepRow = {
  id: string;
  event_id: string;
  step_order: number;
  description: string;
  /** 이 단계에 걸리는 기업들 입장에서의 손익 방향 (0009) */
  direction: ImpactDirection | null;
  relation: RelationType | null;
  /** 왜 그 방향인지 (0009) */
  reason: string | null;
  chain_position: ChainPosition | null;
}

export type EventRequirementRow = {
  id: string;
  event_id: string;
  requirement_type: RequirementType;
  description: string;
  sort_order: number;
}

export type ScoreBreakdown = {
  product: number;
  revenue: number;
  geography: number;
  supplyChain: number;
  disclosure: number;
  recency: number;
  thematic: number;
  /**
   * 사업 집중도 — 매칭이 그 회사가 파는 제품 중 몇 분의 몇인가 (0009).
   * 0009 이전에 채점된 행에는 없다. 화면은 없을 때를 견뎌야 한다.
   */
  focus?: number;
  /** 업종이 이벤트가 건드리는 산업과 맞는가 (0009). 위와 같이 옛 행에는 없다. */
  industry?: number;
  /**
   * 기사에 이름이 직접 나와서 받은 점수 (lib/events/mentions.ts).
   * 다른 항목과 달리 LLM 분석 없이도 채워지므로 나머지가 전부 0 일 수 있다.
   */
  mention?: number;
  /**
   * 이미 붙은 종목과 같은 제품군이라 받은 점수 (lib/events/peers.ts).
   * 이 값이 있으면 "동종 확장으로 붙은 종목"이고, 다시 씨앗이 되지 않는다.
   */
  peer?: number;
  total: number;
  notes: string[];
}

export type EventImpactRow = Timestamps & {
  id: string;
  event_id: string;
  company_id: string;
  impact_direction: ImpactDirection;
  impact_level: ImpactLevel;
  relation_type: RelationType;
  relevance_score: number;
  score_breakdown: ScoreBreakdown | Record<string, never>;
  confidence_score: number | null;
  rationale: string | null;
  transmission_path: string[];
  /**
   * 이 종목이 걸린 전파 단계 번호 (0009).
   * null 은 전파 경로가 아닌 다른 경로(기사 직접 언급·동종 확장)로 붙은 종목이다.
   */
  step_order: number | null;
  evidence_summary: string | null;
  missing_evidence: string[];
  review_status: ReviewStatus;
  is_manual: boolean;
}

export type EventImpactEvidenceRow = {
  impact_id: string;
  evidence_id: string;
}

/* ── 운영 ─────────────────────────────────────────────── */

export type ProfileRow = {
  id: string;
  email: string;
  role: 'user' | 'admin';
  created_at: string;
}

export type AdminReviewRow = {
  id: string;
  target_type: 'event' | 'impact' | 'company' | 'exposure';
  target_id: string;
  reviewer: string | null;
  action: string;
  comment: string | null;
  diff: Json | null;
  created_at: string;
}

export type PipelineRunRow = {
  id: string;
  job_name: string;
  run_key: string;
  started_at: string;
  finished_at: string | null;
  ok: boolean | null;
  stats: Json;
  error: string | null;
}

export type LlmCallRow = {
  id: string;
  purpose: string;
  provider: string;
  model: string;
  event_id: string | null;
  company_id: string | null;
  input_tokens: number;
  output_tokens: number;
  estimated_cost_usd: number;
  ok: boolean;
  error: string | null;
  prompt_hash: string | null;
  created_at: string;
}

export type AppSettingsRow = {
  id: number;
  daily_llm_budget_usd: number;
  collect_enabled: boolean;
  analyze_enabled: boolean;
  max_events_per_tick: number;
  /** MVP 전용 — 사람 검수 없이 공개한다 (0004) */
  auto_publish: boolean;
  /** 기사 직접 언급 매칭 스위치 (0004) */
  mentions_enabled: boolean;
  /** LLM 으로 종목별 긍정·부정까지 판정할 것인가. 켜면 이벤트당 호출이 2배 (0005) */
  judge_impacts: boolean;
  /** 이벤트 구조화 모델 티어 (0005) */
  structure_tier: 'cheap' | 'standard';
  /** 같은 제품군 상장사를 한 발 더 붙이는 동종 확장 스위치 (0006) */
  peers_enabled: boolean;
  /** 전파 경로 추적 스위치. 이벤트당 LLM cheap 1회를 쓴다 (0007) */
  transmission_enabled: boolean;
  updated_at: string;
}

/* ── Database 매핑 ─────────────────────────────────────── */

type Table<Row, Required extends keyof Row = never> = {
  Row: Row;
  Insert: Partial<Row> & Pick<Row, Required>;
  Update: Partial<Row>;
  Relationships: [];
};

export interface Database {
  public: {
    Tables: {
      companies: Table<CompanyRow, 'company_name'>;
      evidence_sources: Table<EvidenceSourceRow, 'source_type' | 'source_title'>;
      company_exposures: Table<
        CompanyExposureRow,
        'company_id' | 'exposure_type' | 'exposure_value' | 'normalized_value'
      >;
      synonyms: Table<SynonymRow, 'term' | 'alias'>;
      news_articles: Table<
        NewsArticleRow,
        'title' | 'cleaned_title' | 'published_at' | 'title_hash'
      >;
      watch_keywords: Table<WatchKeywordRow, 'keyword'>;
      events: Table<EventRow, 'title'>;
      event_articles: Table<EventArticleRow, 'event_id' | 'article_id'>;
      event_transmission_steps: Table<
        EventTransmissionStepRow,
        'event_id' | 'step_order' | 'description'
      >;
      event_requirements: Table<
        EventRequirementRow,
        'event_id' | 'requirement_type' | 'description'
      >;
      event_impacts: Table<EventImpactRow, 'event_id' | 'company_id' | 'relevance_score'>;
      event_impact_evidence: Table<EventImpactEvidenceRow, 'impact_id' | 'evidence_id'>;
      profiles: Table<ProfileRow, 'id' | 'email'>;
      admin_reviews: Table<AdminReviewRow, 'target_type' | 'target_id' | 'action'>;
      pipeline_runs: Table<PipelineRunRow, 'job_name' | 'run_key'>;
      llm_calls: Table<LlmCallRow, 'purpose' | 'provider' | 'model'>;
      app_settings: Table<AppSettingsRow, 'id'>;
    };
    Views: {
      v_llm_cost_today: { Row: { cost_usd: number; calls: number }; Relationships: [] };
    };
    Functions: {
      is_admin: { Args: Record<string, never>; Returns: boolean };
      job_is_running: { Args: { p_job: string; p_stale_minutes?: number }; Returns: boolean };
      match_exposures: {
        Args: { p_embedding: string; p_threshold: number; p_limit: number };
        Returns: Array<{ company_id: string; exposure_id: string; similarity: number }>;
      };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}
