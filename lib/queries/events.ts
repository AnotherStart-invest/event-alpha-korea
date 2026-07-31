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
};

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
    .select(`${CARD_COLUMNS}, event_impacts(impact_direction), event_articles(article_id)`)
    .eq('status', 'published')
    .order('published_at', { ascending: false })
    .limit(options.limit ?? 40);

  if (options.eventType) query = query.eq('event_type', options.eventType);

  const { data, error } = await query;
  if (error) throw new Error(`이벤트 조회 실패: ${error.message}`);

  type Joined = EventCard & {
    event_impacts: Array<{ impact_direction: ImpactDirection }> | null;
    event_articles: Array<{ article_id: string }> | null;
  };

  return ((data ?? []) as unknown as Joined[]).map((row) => {
    const impacts = row.event_impacts ?? [];
    return {
      ...row,
      positiveCount: impacts.filter((i) => i.impact_direction === 'positive').length,
      negativeCount: impacts.filter((i) => i.impact_direction === 'negative').length,
      sourceCount: (row.event_articles ?? []).length,
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
