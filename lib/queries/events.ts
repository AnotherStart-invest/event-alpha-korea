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

/**
 * 이 종목이 **어떤 근거로** 붙었는가.
 *
 * ⚠️ 화면이 이걸 틀리게 부르고 있었다. "peer 가 아니면 전부 기사 언급" 으로 취급해서,
 * KRX 주요제품 문자열이 겹쳤을 뿐인 종목이 **"기사에 언급된 상장사"** 로 나갔다.
 *
 * 실측(TSMC 구마모토 공장 중단 기사): 표시된 9종목이 **전부** 문자열 매칭이었고
 * 진짜 기사 언급은 0건이었다. 롯데하이마트·CJ ENM 은 원문에 나오지도 않는다.
 * 근거로 보여준 문장조차 기사가 아니라 그 회사의 KRX 주요제품 설명이었다.
 *
 * 이건 정확도 문제가 아니라 **라벨이 사실이 아닌** 문제다. 종류를 데이터로 판정한다.
 */
export type ImpactOrigin = 'mention' | 'llm' | 'peer' | 'keyword';

export function impactOrigin(impact: ImpactWithCompany): ImpactOrigin {
  const b = impact.score_breakdown as ScoreBreakdown;
  if (typeof b?.mention === 'number') return 'mention';
  if (typeof b?.llm === 'number') return 'llm';
  if (typeof b?.peer === 'number') return 'peer';
  return 'keyword';
}

/** 기사 본문에 회사 이름이 실제로 나온 종목인가. */
export function isMentionImpact(impact: ImpactWithCompany): boolean {
  return impactOrigin(impact) === 'mention';
}

export const ORIGIN_LABELS: Record<ImpactOrigin, string> = {
  mention: '원문 직접 언급',
  llm: 'AI 사업구조 판단',
  peer: '같은 제품군',
  keyword: '키워드 검색 후보',
};

export const ORIGIN_HINTS: Record<ImpactOrigin, string> = {
  mention: '기사 본문에 회사 이름이 그대로 나왔습니다.',
  llm: 'AI 가 사업 구조로 지목하고 상장사 사전에서 실존을 확인했습니다. 기사에 이름이 나온 것은 아닙니다.',
  peer: '이미 붙은 종목과 주요제품이 겹칩니다. 기사에 이름이 나온 것은 아닙니다.',
  keyword:
    '이벤트 키워드가 이 회사의 KRX 주요제품 설명과 겹쳐 검색된 후보입니다. **기사에 이름이 나온 것이 아니며**, 실제 영향은 확인되지 않았습니다.',
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
  | 'step_order'
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
    market_cap: number | null;
    price_updated_at: string | null;
    /** 이 기업이 파는 제품 가짓수. 적을수록 매칭 하나의 무게가 크다 (0009) */
    product_exposure_count: number;
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
    // **화면이 보여주는 날짜로 정렬한다.**
    // published_at(승인 시각)으로 정렬하면서 event_occurred_at(사건 시각)을 보여주고
    // 있었다. 자동 공개는 cron 이 집어가는 시점이라 둘이 따로 놀고, 그래서 목록이
    // 08.01 → 07.31 → 08.01 처럼 뒤죽박죽으로 보였다.
    // 정렬 키와 표시 값이 다르면 사용자는 목록이 고장 났다고 읽는다.
    .order('event_occurred_at', { ascending: false, nullsFirst: false })
    // 사건 시각이 없거나 같을 때의 2차 기준.
    .order('published_at', { ascending: false, nullsFirst: false })
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
         rationale, transmission_path, step_order, missing_evidence, score_breakdown,
         company:companies(id, company_name, stock_code, market, industry_name, latest_report_date,
                           market_cap, price_updated_at, product_exposure_count),
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

/* ── 밸류체인 ─────────────────────────────────────────── */

/**
 * 한 단계에 보여줄 종목 수. 한 이벤트 전체로는 최대 STEP × 3 이다.
 *
 * 나열이 아니라 선별이 목적이다. 이 시스템의 매칭은 "관련 있어 보이는 것"을 넓게
 * 긁어오도록 돼 있어서, 상한이 없으면 화면이 20종목짜리 명단이 되고 그 순간
 * 투자자가 읽을 이유가 사라진다. 못 보여준 종목은 접어서 세어만 준다.
 */
export const VISIBLE_PER_STEP = 3;

/**
 * 이 점수 미만은 아예 후보에서 뺀다.
 *
 * **40 → 30 으로 내렸다.** 용어 변별력 가중치가 들어오면서 점수 분포가 통째로
 * 내려갔기 때문이다. 실측: "리튬"(1개사) 정확 일치로 걸린 성일하이텍이 36점,
 * "반도체 설계" 로 걸린 세미파이브가 49점 — 옛 컷(40)이면 성일하이텍처럼 정확한
 * 매칭이 잘려 밸류체인 전체가 빈 화면이 됐다.
 *
 * 이제 잡스러운 종목은 이 컷이 아니라 **매칭 단계에서** 걸러진다
 * (scoring.ts 의 R6 + 변별력 가중치). 컷은 남은 것 중 가장 약한 것만 떨어뜨린다.
 * 새 기준: 구체적 용어 하나(20) 또는 어중간한 용어 + 실제 사업 집중도(10+10).
 */
export const DISPLAY_SCORE_FLOOR = 30;

/**
 * 0009 의 새 점수 체계로 채점된 행인가.
 *
 * focus 는 0009 에서 생겼으므로, 이 값이 아예 없으면 옛 체계로 매긴 점수다.
 * 옛 점수는 최대가 35점이라 40점 컷을 그대로 들이대면 화면이 전부 빈다.
 * 그래서 컷은 새로 채점된 행에만 적용하고, 옛 행은 순위로만 거른다.
 * 전체를 재추적하고 나면 이 분기는 자연히 죽는다.
 */
function isRescored(impact: ImpactWithCompany): boolean {
  return typeof (impact.score_breakdown as ScoreBreakdown)?.focus === 'number';
}

/**
 * 표시 순위.
 *
 * 1순위 관련도 — 사용자가 고른 정책이다. 집중도·업종이 들어오면서 관련도가
 *   비로소 종목을 변별하게 됐다.
 * 2순위 집중도 점수 — 관련도가 같으면 사업이 더 집중된 쪽이 먼저다.
 * 3순위 제품 가짓수 — **옛 행을 구제하는 축이다.** 재채점 전에는 1·2순위가
 *   전부 동점이라(35점 무리) 순서를 못 정하는데, companies.product_exposure_count
 *   는 마이그레이션이 전 종목에 채워 두므로 LLM 없이 지금 당장 쓸 수 있다.
 *   실측: 라온시큐어 1개 · 세미파이브 1개 · 비상교육 2개 … SK 8개 · 사조산업 12개.
 *   적은 쪽이 먼저다 — 그것만 파는 회사에게 이 사건이 곧 실적이다.
 * 4순위 시가총액 — 위가 모두 같을 때. 같은 근거라면 큰 회사가 먼저 눈에 든다.
 * 5순위 이름 — 정렬을 안정시킨다. 없으면 순서가 실행마다 달라져 화면이 흔들린다.
 */
export function compareForDisplay(a: ImpactWithCompany, b: ImpactWithCompany): number {
  return byRelevance(a, b);
}

/**
 * 밸류체인이 없는 이벤트(전파 경로를 못 그렸거나 분석 경로로만 종목이 붙은 경우)의
 * 표에 실을 종목 수.
 *
 * 단계별 레인보다 조금 넉넉하다 — 여기는 단계 구분이 없어 표가 하나뿐이라서
 * 3개만 실으면 정보가 지나치게 깎인다.
 */
export const VISIBLE_PER_GROUP = 5;

function byRelevance(a: ImpactWithCompany, b: ImpactWithCompany): number {
  if (a.relevance_score !== b.relevance_score) return b.relevance_score - a.relevance_score;

  const focusA = (a.score_breakdown as ScoreBreakdown)?.focus ?? 0;
  const focusB = (b.score_breakdown as ScoreBreakdown)?.focus ?? 0;
  if (focusA !== focusB) return focusB - focusA;

  // 가짓수를 모르는 기업(0)은 뒤로 보낸다. 0 을 "가장 집중됨" 으로 읽으면
  // 데이터가 없는 기업이 1등이 되는 역전이 생긴다.
  const countA = a.company?.product_exposure_count || Number.MAX_SAFE_INTEGER;
  const countB = b.company?.product_exposure_count || Number.MAX_SAFE_INTEGER;
  if (countA !== countB) return countA - countB;

  const capA = a.company?.market_cap ?? -1;
  const capB = b.company?.market_cap ?? -1;
  if (capA !== capB) return capB - capA;

  return (a.company?.company_name ?? '').localeCompare(b.company?.company_name ?? '', 'ko');
}

/**
 * 코넥스는 사실상 거래가 안 된다. 점수가 아무리 높아도 투자 후보가 아니므로
 * 아예 후보에서 뺀다.
 */
function isTradable(impact: ImpactWithCompany): boolean {
  return impact.company?.market !== 'KONEX';
}

/** 관련도 컷 → 관련도 순 → 상위 N개. 나머지는 세기만 한다. */
function rankForDisplay(impacts: ImpactWithCompany[], limit = VISIBLE_PER_STEP) {
  const eligible = impacts
    .filter(
      (i) => isTradable(i) && (!isRescored(i) || i.relevance_score >= DISPLAY_SCORE_FLOOR),
    )
    .sort(byRelevance);

  return {
    shown: eligible.slice(0, limit),
    /** 컷 아래이거나 상한에 밀려 화면에 못 올라간 종목 수 */
    hiddenCount: impacts.length - Math.min(eligible.length, limit),
  };
}

export type ChainLane = {
  step: EventTransmissionStepRow;
  /** 이 단계에서 보여줄 종목. 관련도 순, 최대 VISIBLE_PER_STEP 개. */
  shown: ImpactWithCompany[];
  /** 컷에 걸렸거나 상한에 밀린 종목 수 */
  hiddenCount: number;
};

export type ValueChain = {
  lanes: ChainLane[];
  /** 어느 단계에도 붙지 않은 종목 (기사 직접 언급·동종 확장으로 붙은 것) */
  unassigned: { shown: ImpactWithCompany[]; hiddenCount: number };
  /** 레인에 실제로 종목이 하나라도 있는가. 없으면 밸류체인 화면을 그릴 이유가 없다. */
  hasChain: boolean;
};

/**
 * 전파 단계를 축으로 종목을 배열한다.
 *
 * 이 함수가 생기기 전에는 505개나 쌓인 단계 정보를 화면이 통째로 버리고 있었다.
 * 종목이 몇 단계에서 걸렸는지는 transmission.ts 가 알고 있었지만 rationale
 * 문자열에만 남아 있어 읽을 수가 없었다(0009 에서 step_order 로 승격).
 */
export function buildValueChain(
  steps: EventTransmissionStepRow[],
  impacts: ImpactWithCompany[],
): ValueChain {
  const ordered = [...steps].sort((a, b) => a.step_order - b.step_order);

  const lanes: ChainLane[] = ordered.map((step) => {
    const mine = impacts.filter((i) => i.step_order === step.step_order);
    return { step, ...rankForDisplay(mine) };
  });

  const assigned = new Set(ordered.map((s) => s.step_order));
  const rest = impacts.filter((i) => i.step_order === null || !assigned.has(i.step_order));

  return {
    lanes,
    unassigned: rankForDisplay(rest),
    hasChain: lanes.some((lane) => lane.shown.length > 0),
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
