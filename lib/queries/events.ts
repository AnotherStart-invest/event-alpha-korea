import 'server-only';
import { createServerSupabase } from '@/lib/db/server';
import type {
  EventImpactRow,
  EventRequirementRow,
  EventRow,
  EventTransmissionStepRow,
  NewsArticleRow,
  ScoreBreakdown,
} from '@/lib/db/types';
import type { EventType, ImpactDirection, RelationType } from '@/lib/db/enums';

/**
 * 공개 화면용 조회.
 *
 * 반드시 anon 세션 클라이언트를 쓴다. service_role 을 쓰면 RLS 가 우회되어
 * 미승인 이벤트가 새어나갈 수 있다 (I8). 여기서 상태 필터를 추가로 걸긴 하지만
 * 진짜 방어선은 RLS 다.
 */

export type EventCard = Pick<
  EventRow,
  | 'id'
  | 'title'
  | 'factual_summary'
  | 'event_type'
  | 'primary_variable'
  | 'variable_direction'
  | 'time_horizon'
  | 'event_confidence'
  | 'event_occurred_at'
  | 'published_at'
  | 'status'
> & {
  positiveCount: number;
  negativeCount: number;
  sourceCount: number;
  /** 이 이벤트에 붙은 관련 종목 수 */
  companyCount: number;
  /** 종목별 방향까지 판정됐는가. 아니면 긍정/부정 대신 종목 수를 보여준다 */
  judged: boolean;
  /** 카드에 미리 보여줄 상위 종목. 관련도 높은 순 */
  topCompanies: Array<{ name: string; stockCode: string | null }>;
};

/**
 * LLM 분석(전파 경로·방향 판정)이 아직 안 된 이벤트인가.
 *
 * 무료 티어에서는 분석 한도가 하루 10건이라 대부분의 이벤트가 이 상태로 남는다.
 * 그래도 기사에 이름이 나온 종목은 붙어 있으므로(lib/events/mentions.ts)
 * 화면은 "관련 종목 목록"까지만 보여주고 나머지 섹션은 감춘다.
 */
export function isAnalyzed(event: Pick<EventRow, 'factual_summary' | 'event_type'>): boolean {
  return Boolean(event.factual_summary) && Boolean(event.event_type);
}

/**
 * 종목별 방향(긍정·부정)까지 LLM 이 판정했는가.
 *
 * app_settings.judge_impacts 가 꺼져 있으면 관련 종목은 붙되 전부 uncertain 이다.
 * 그 경우 긍정/부정 섹션을 나눠 봐야 양쪽 다 비므로 한 표로 합쳐 보여준다.
 */
export function hasDirectionJudgement(impacts: ImpactWithCompany[]): boolean {
  return impacts.some((impact) => impact.impact_direction !== 'uncertain');
}

/**
 * 동종 확장(lib/events/peers.ts)으로 붙은 종목인가.
 *
 * 기사에 이름이 나온 종목과 근거의 성격이 다르다 — 이쪽은 "같은 제품을 판다"가
 * 전부다. 한 표에 섞으면 "기사에 언급된 상장사"라는 표 제목이 거짓말이 되므로
 * 화면에서 갈라 놓는다.
 */
export function isPeerImpact(impact: ImpactWithCompany): boolean {
  return typeof (impact.score_breakdown as ScoreBreakdown)?.peer === 'number';
}

export type ImpactWithCompany = Pick<
  EventImpactRow,
  | 'id'
  | 'impact_direction'
  | 'impact_level'
  | 'relation_type'
  | 'relevance_score'
  | 'confidence_score'
  | 'rationale'
  | 'transmission_path'
  | 'missing_evidence'
> & {
  score_breakdown: ScoreBreakdown | Record<string, never>;
  company: {
    id: string;
    company_name: string;
    stock_code: string | null;
    market: string | null;
    industry_name: string | null;
    latest_report_date: string | null;
  } | null;
  evidence: Array<{
    id: string;
    source_type: string;
    source_title: string;
    source_url: string | null;
    source_date: string | null;
    excerpt: string | null;
  }>;
};

export type EventDetail = {
  event: EventRow;
  articles: Array<Pick<NewsArticleRow, 'id' | 'title' | 'source_name' | 'original_url' | 'published_at'>>;
  steps: EventTransmissionStepRow[];
  requirements: EventRequirementRow[];
  impacts: ImpactWithCompany[];
};

const CARD_COLUMNS =
  'id, title, factual_summary, event_type, primary_variable, variable_direction, time_horizon, event_confidence, event_occurred_at, published_at, status';

export async function listPublishedEvents(options: {
  eventType?: EventType;
  limit?: number;
} = {}): Promise<EventCard[]> {
  const supabase = await createServerSupabase();

  let query = supabase
    .from('events')
    .select(
      `${CARD_COLUMNS},
       event_impacts(impact_direction, relevance_score, company:companies(company_name, stock_code)),
       event_articles(article_id)`,
    )
    .eq('status', 'published')
    .order('published_at', { ascending: false })
    .limit(options.limit ?? 40);

  if (options.eventType) query = query.eq('event_type', options.eventType);

  const { data, error } = await query;
  if (error) throw new Error(`이벤트 조회 실패: ${error.message}`);

  type JoinedCompany = { company_name: string; stock_code: string | null };
  type Joined = EventCard & {
    event_impacts: Array<{
      impact_direction: ImpactDirection;
      relevance_score: number;
      company: JoinedCompany | JoinedCompany[] | null;
    }> | null;
    event_articles: Array<{ article_id: string }> | null;
  };

  return ((data ?? []) as unknown as Joined[]).map((row) => {
    const impacts = row.event_impacts ?? [];
    const topCompanies = [...impacts]
      .sort((a, b) => b.relevance_score - a.relevance_score)
      .map((i) => (Array.isArray(i.company) ? i.company[0] : i.company))
      .filter((c): c is JoinedCompany => Boolean(c))
      .slice(0, 4)
      .map((c) => ({ name: c.company_name, stockCode: c.stock_code }));

    return {
      ...row,
      positiveCount: impacts.filter((i) => i.impact_direction === 'positive').length,
      negativeCount: impacts.filter((i) => i.impact_direction === 'negative').length,
      sourceCount: (row.event_articles ?? []).length,
      companyCount: impacts.length,
      judged: impacts.some((i) => i.impact_direction !== 'uncertain'),
      topCompanies,
    };
  });
}

export async function getPublishedEvent(id: string): Promise<EventDetail | null> {
  const supabase = await createServerSupabase();

  const { data: event, error } = await supabase
    .from('events')
    .select('*')
    .eq('id', id)
    .eq('status', 'published')
    .maybeSingle();

  if (error) throw new Error(`이벤트 조회 실패: ${error.message}`);
  if (!event) return null;

  return loadDetail(supabase, event as EventRow);
}

/** 관리자 검수용 — 상태와 무관하게 조회한다 (RLS 의 admin 정책으로 보호됨). */
export async function getEventForReview(id: string): Promise<EventDetail | null> {
  const supabase = await createServerSupabase();
  const { data: event, error } = await supabase.from('events').select('*').eq('id', id).maybeSingle();
  if (error) throw new Error(`이벤트 조회 실패: ${error.message}`);
  if (!event) return null;
  return loadDetail(supabase, event as EventRow);
}

async function loadDetail(
  supabase: Awaited<ReturnType<typeof createServerSupabase>>,
  event: EventRow,
): Promise<EventDetail> {
  const [stepsResult, requirementsResult, impactsResult, articlesResult] = await Promise.all([
    supabase.from('event_transmission_steps').select('*').eq('event_id', event.id).order('step_order'),
    supabase.from('event_requirements').select('*').eq('event_id', event.id).order('sort_order'),
    supabase
      .from('event_impacts')
      .select(
        `id, impact_direction, impact_level, relation_type, relevance_score, confidence_score,
         rationale, transmission_path, missing_evidence, score_breakdown,
         company:companies(id, company_name, stock_code, market, industry_name, latest_report_date),
         event_impact_evidence(evidence:evidence_sources(id, source_type, source_title, source_url, source_date, excerpt))`,
      )
      .eq('event_id', event.id)
      .order('relevance_score', { ascending: false }),
    supabase
      .from('event_articles')
      .select('article:news_articles(id, title, source_name, original_url, published_at)')
      .eq('event_id', event.id),
  ]);

  type RawImpact = Omit<ImpactWithCompany, 'company' | 'evidence'> & {
    company: ImpactWithCompany['company'] | ImpactWithCompany['company'][];
    event_impact_evidence: Array<{
      evidence: ImpactWithCompany['evidence'][number] | ImpactWithCompany['evidence'][number][] | null;
    }> | null;
  };

  const impacts: ImpactWithCompany[] = ((impactsResult.data ?? []) as unknown as RawImpact[]).map(
    (row) => ({
      ...row,
      company: Array.isArray(row.company) ? (row.company[0] ?? null) : row.company,
      evidence: (row.event_impact_evidence ?? [])
        .map((link) => (Array.isArray(link.evidence) ? link.evidence[0] : link.evidence))
        .filter((e): e is ImpactWithCompany['evidence'][number] => Boolean(e)),
    }),
  );

  type RawArticle = { article: EventDetail['articles'][number] | EventDetail['articles'][number][] | null };
  const articles = ((articlesResult.data ?? []) as unknown as RawArticle[])
    .map((row) => (Array.isArray(row.article) ? row.article[0] : row.article))
    .filter((a): a is EventDetail['articles'][number] => Boolean(a))
    .sort((a, b) => new Date(a.published_at).getTime() - new Date(b.published_at).getTime());

  return {
    event,
    articles,
    steps: (stepsResult.data ?? []) as EventTransmissionStepRow[],
    requirements: (requirementsResult.data ?? []) as EventRequirementRow[],
    impacts,
  };
}

/** 상세 페이지 6개 그룹으로 나눈다 (PRODUCT_SPEC §6.2) */
export function groupImpacts(impacts: ImpactWithCompany[]) {
  const isThematic = (relation: RelationType) => relation === 'thematic';
  const isSecondary = (relation: RelationType) =>
    relation === 'supply_chain' || relation === 'competitor' || relation === 'substitute';

  const direct = impacts.filter((i) => !isThematic(i.relation_type) && !isSecondary(i.relation_type));

  return {
    positive: direct.filter((i) => i.impact_direction === 'positive'),
    negative: direct.filter((i) => i.impact_direction === 'negative'),
    other: direct.filter((i) => i.impact_direction === 'mixed' || i.impact_direction === 'uncertain'),
    supplyChain: impacts.filter((i) => isSecondary(i.relation_type)),
    thematic: impacts.filter((i) => isThematic(i.relation_type)),
  };
}
