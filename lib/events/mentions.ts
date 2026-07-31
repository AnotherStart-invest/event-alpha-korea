import 'server-only';
import type { ServiceClient } from '@/lib/db/service';
import type { EventStatus } from '@/lib/db/enums';
import type { ScoreBreakdown } from '@/lib/db/types';
import type { Logger } from '@/lib/shared/logger';
import { buildMentionDict, findMentions, type MentionCompany, type MentionDict } from '@/lib/matching/mentions';

/**
 * 이벤트 ↔ **기사에 직접 이름이 나온 상장사** 를 잇는다. LLM 을 한 번도 부르지 않는다.
 *
 * 이 잡의 존재 이유는 비용이다. 원래 경로(analyze.ts)는 이벤트 한 건에
 * standard 모델 호출 2회가 필요한데 무료 티어 한도가 하루 20회라 하루 10건이 상한이다.
 * 반면 기사는 이미 종목명을 말하고 있고, 그걸 읽는 데는 토큰이 들지 않는다.
 *
 * 만들어내는 것은 "관련 종목 목록"까지다. 방향(긍정·부정) 판정은 하지 않는다 —
 * 근거 없이 방향을 붙이면 그건 지어내는 것이고, 방향은 analyze.ts 가 나중에 덮어쓴다.
 */

export type MentionStats = {
  events: number;
  articles: number;
  impacts: number;
  skippedExisting: number;
  published: number;
};

/** 제목에 이름이 나온 경우 */
const TITLE_SCORE = 60;
/** 본문에만 나온 경우 */
const BODY_SCORE = 45;

/** 한 이벤트에 붙일 수 있는 언급 종목 수. 이보다 많으면 기사 나열일 뿐 이벤트가 아니다. */
const MAX_COMPANIES_PER_EVENT = 15;

/** 언급 매칭 대상 상태. rejected·failed 는 건드리지 않는다. */
const TARGET_STATUSES: EventStatus[] = ['candidate', 'analyzed', 'pending_review', 'published'];

type EventRow = { id: string; status: EventStatus };

type ArticleRow = {
  id: string;
  title: string;
  description: string | null;
  original_url: string | null;
  source_name: string | null;
  published_at: string | null;
};

export async function linkMentionedCompanies(
  supabase: ServiceClient,
  log: Logger,
  options: { limit?: number; eventIds?: string[] } = {},
): Promise<MentionStats> {
  const stats: MentionStats = { events: 0, articles: 0, impacts: 0, skippedExisting: 0, published: 0 };

  const { data: settings } = await supabase
    .from('app_settings')
    .select('mentions_enabled, auto_publish')
    .eq('id', 1)
    .maybeSingle();

  if (settings?.mentions_enabled === false) {
    log.info('언급 매칭이 꺼져 있음');
    return stats;
  }

  const dict = await loadMentionDict(supabase);
  if (dict.byKey.size === 0) {
    log.warn('상장사 사전이 비어 있음 — sync_krx 를 먼저 돌렸는지 확인할 것');
    return stats;
  }
  log.info('상장사 사전 준비', { names: dict.byKey.size });

  const events = await loadEvents(supabase, options);
  log.info('대상 이벤트', { count: events.length });

  for (const event of events) {
    const articles = await loadArticles(supabase, event.id);
    if (articles.length === 0) continue;
    stats.events++;
    stats.articles += articles.length;

    // 같은 회사가 여러 기사에 나오면 제목 언급을 우선한다.
    const best = new Map<string, { company: MentionCompany; article: ArticleRow; excerpt: string; inTitle: boolean }>();
    for (const article of articles) {
      for (const mention of findMentions(dict, article)) {
        const existing = best.get(mention.company.companyId);
        if (existing && (existing.inTitle || !mention.inTitle)) continue;
        best.set(mention.company.companyId, {
          company: mention.company,
          article,
          excerpt: mention.excerpt,
          inTitle: mention.inTitle,
        });
      }
    }

    if (best.size === 0) continue;
    if (best.size > MAX_COMPANIES_PER_EVENT) {
      log.info('언급 종목이 너무 많아 건너뜀', { event_id: event.id, count: best.size });
      continue;
    }

    // 이미 붙어 있는 종목은 손대지 않는다. analyze.ts 가 판정한 방향을
    // 'uncertain' 으로 덮어쓰면 정보가 사라진다.
    const existingCompanyIds = await loadExistingImpactCompanyIds(supabase, event.id);
    const fresh = Array.from(best.values()).filter((m) => !existingCompanyIds.has(m.company.companyId));
    stats.skippedExisting += best.size - fresh.length;
    if (fresh.length === 0) continue;

    const evidenceByCompany = await ensureNewsEvidence(supabase, fresh);
    const inserted = await insertImpacts(supabase, event.id, fresh, evidenceByCompany);
    stats.impacts += inserted;

    if (settings?.auto_publish && inserted > 0 && event.status !== 'published') {
      await publish(supabase, event.id);
      stats.published++;
    }
  }

  log.info('언급 매칭 완료', { ...stats });
  return stats;
}

/* ── 사전 ─────────────────────────────────────────────── */

const PAGE = 1000;

/**
 * 상장 종목만 사전에 넣는다.
 *
 * is_listed 필터가 중요하다. companies 에는 OpenDART corpCode.xml 에서 온
 * 상장폐지 법인이 1,100여 건 섞여 있고, 그중에는 "도움", "우방" 처럼
 * 일반명사와 구분되지 않는 이름이 많다.
 */
export async function loadMentionDict(supabase: ServiceClient): Promise<MentionDict> {
  const companies: MentionCompany[] = [];
  let offset = 0;

  for (;;) {
    const { data, error } = await supabase
      .from('companies')
      .select('id, company_name, stock_code, market, industry_name, latest_report_date')
      .not('stock_code', 'is', null)
      .eq('is_listed', true)
      .range(offset, offset + PAGE - 1);

    if (error) throw new Error(`상장사 조회 실패: ${error.message}`);
    const rows = data ?? [];
    for (const row of rows) {
      if (!row.stock_code) continue;
      companies.push({
        companyId: row.id,
        companyName: row.company_name,
        stockCode: row.stock_code,
        market: row.market,
        industryName: row.industry_name,
        latestReportDate: row.latest_report_date,
      });
    }
    if (rows.length < PAGE) break;
    offset += PAGE;
  }

  return buildMentionDict(companies);
}

/* ── 조회 ─────────────────────────────────────────────── */

async function loadEvents(
  supabase: ServiceClient,
  options: { limit?: number; eventIds?: string[] },
): Promise<EventRow[]> {
  let query = supabase
    .from('events')
    .select('id, status')
    .in('status', TARGET_STATUSES)
    .order('event_occurred_at', { ascending: false });

  if (options.eventIds?.length) query = query.in('id', options.eventIds);
  if (options.limit) query = query.limit(options.limit);

  const { data, error } = await query;
  if (error) throw new Error(`이벤트 조회 실패: ${error.message}`);
  return (data ?? []) as EventRow[];
}

async function loadArticles(supabase: ServiceClient, eventId: string): Promise<ArticleRow[]> {
  const { data, error } = await supabase
    .from('event_articles')
    .select('news_articles(id, title, description, original_url, source_name, published_at)')
    .eq('event_id', eventId)
    .limit(10);

  if (error) throw new Error(`기사 조회 실패: ${error.message}`);

  type Joined = { news_articles: ArticleRow | ArticleRow[] | null };
  return ((data ?? []) as unknown as Joined[])
    .map((row) => (Array.isArray(row.news_articles) ? row.news_articles[0] : row.news_articles))
    .filter((a): a is ArticleRow => Boolean(a));
}

async function loadExistingImpactCompanyIds(
  supabase: ServiceClient,
  eventId: string,
): Promise<Set<string>> {
  const { data, error } = await supabase.from('event_impacts').select('company_id').eq('event_id', eventId);
  if (error) throw new Error(`기존 영향 조회 실패: ${error.message}`);
  return new Set((data ?? []).map((row) => row.company_id));
}

/* ── 쓰기 ─────────────────────────────────────────────── */

type Hit = { company: MentionCompany; article: ArticleRow; excerpt: string; inTitle: boolean };

/**
 * 기사 발췌를 근거로 남긴다.
 *
 * 같은 (기업, 기사 URL) 근거가 이미 있으면 재사용한다. 유일 제약을 걸고 upsert 하지
 * 않는 이유는 부분 유일 인덱스에서 PostgREST 의 ON CONFLICT 추론이 실패하기 때문이다.
 */
async function ensureNewsEvidence(supabase: ServiceClient, hits: Hit[]): Promise<Map<string, string>> {
  const byCompany = new Map<string, string>();
  const urls = Array.from(new Set(hits.map((h) => h.article.original_url).filter((u): u is string => Boolean(u))));

  if (urls.length > 0) {
    const { data, error } = await supabase
      .from('evidence_sources')
      .select('id, company_id, source_url')
      .eq('source_type', 'news')
      .in('company_id', hits.map((h) => h.company.companyId))
      .in('source_url', urls);
    if (error) throw new Error(`근거 조회 실패: ${error.message}`);
    for (const row of data ?? []) {
      if (row.company_id) byCompany.set(`${row.company_id}|${row.source_url}`, row.id);
    }
  }

  const missing = hits.filter((h) => !byCompany.has(`${h.company.companyId}|${h.article.original_url}`));
  if (missing.length > 0) {
    const { data, error } = await supabase
      .from('evidence_sources')
      .insert(
        missing.map((hit) => ({
          company_id: hit.company.companyId,
          source_type: 'news' as const,
          source_title: hit.article.title.slice(0, 300),
          source_url: hit.article.original_url,
          source_date: hit.article.published_at?.slice(0, 10) ?? null,
          // excerpt 는 DB 에서 500자 제약이 걸려 있다.
          excerpt: hit.excerpt.slice(0, 500),
        })),
      )
      .select('id, company_id, source_url');
    if (error) throw new Error(`근거 저장 실패: ${error.message}`);
    for (const row of data ?? []) {
      if (row.company_id) byCompany.set(`${row.company_id}|${row.source_url}`, row.id);
    }
  }

  const result = new Map<string, string>();
  for (const hit of hits) {
    const id = byCompany.get(`${hit.company.companyId}|${hit.article.original_url}`);
    if (id) result.set(hit.company.companyId, id);
  }
  return result;
}

/**
 * 언급만으로 받은 점수. 다른 항목은 전부 0 이다 — 매출·공시·공급망 근거를
 * 확인한 적이 없으므로 0 이 아닌 값을 넣으면 거짓말이 된다.
 */
function breakdown(hit: Hit): ScoreBreakdown {
  const score = hit.inTitle ? TITLE_SCORE : BODY_SCORE;
  return {
    product: 0,
    revenue: 0,
    geography: 0,
    supplyChain: 0,
    disclosure: 0,
    recency: 0,
    thematic: 0,
    mention: score,
    total: score,
    notes: [`기사 ${hit.inTitle ? '제목' : '본문'}에 "${hit.company.companyName}" 언급`],
  };
}

async function insertImpacts(
  supabase: ServiceClient,
  eventId: string,
  hits: Hit[],
  evidenceByCompany: Map<string, string>,
): Promise<number> {
  const { data, error } = await supabase
    .from('event_impacts')
    .upsert(
      hits.map((hit) => ({
        event_id: eventId,
        company_id: hit.company.companyId,
        // 방향은 판정하지 않는다. 근거는 "이름이 나왔다" 뿐이다.
        impact_direction: 'uncertain' as const,
        impact_level: 'low' as const,
        relation_type: 'direct' as const,
        relevance_score: hit.inTitle ? TITLE_SCORE : BODY_SCORE,
        score_breakdown: breakdown(hit),
        confidence_score: null,
        rationale: `기사 ${hit.inTitle ? '제목' : '본문'}에 직접 언급된 종목입니다. 영향의 방향과 크기는 판정하지 않았습니다.`,
        review_status: 'pending' as const,
        is_manual: false,
      })),
      { onConflict: 'event_id,company_id' },
    )
    .select('id, company_id');

  if (error) throw new Error(`영향 종목 저장 실패: ${error.message}`);

  const links = (data ?? []).flatMap((row) => {
    const evidenceId = evidenceByCompany.get(row.company_id);
    return evidenceId ? [{ impact_id: row.id, evidence_id: evidenceId }] : [];
  });
  if (links.length > 0) {
    const { error: linkError } = await supabase
      .from('event_impact_evidence')
      .upsert(links, { onConflict: 'impact_id,evidence_id', ignoreDuplicates: true });
    if (linkError) throw new Error(`근거 연결 실패: ${linkError.message}`);
  }

  return data?.length ?? 0;
}

/**
 * MVP 자동 공개. app_settings.auto_publish 가 켜져 있을 때만 불린다.
 * published_requires_ts 제약 때문에 두 타임스탬프를 반드시 같이 채워야 한다.
 */
async function publish(supabase: ServiceClient, eventId: string): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await supabase
    .from('events')
    .update({ status: 'published', published_at: now, approved_at: now, reviewed_at: now })
    .eq('id', eventId);
  if (error) throw new Error(`자동 공개 실패: ${error.message}`);
}
