import 'server-only';
import type { ServiceClient } from '@/lib/db/service';
import type { Logger } from '@/lib/shared/logger';
import { titleHash } from './normalize';
import {
  MAX_HOURS_APART,
  clusterArticles,
  evaluateMerge,
  type ClusterableArticle,
} from './cluster';

export const ARTICLES_PER_TICK = 100;

export type ClusterStats = {
  articles: number;
  attachedToExisting: number;
  newEvents: number;
  links: number;
};

type RecentEvent = { id: string; title: string; event_occurred_at: string };

/**
 * 미처리 기사를 이벤트로 묶는다.
 *
 * 순서가 중요하다: 먼저 **기존 이벤트**에 붙일 수 있는지 보고, 안 되면 배치 안에서
 * 새로 묶는다. 이 순서를 뒤집으면 같은 사건이 tick 마다 새 이벤트로 쪼개진다.
 */
export async function clusterPendingArticles(
  supabase: ServiceClient,
  log: Logger,
  options: { limit?: number } = {},
): Promise<ClusterStats> {
  const limit = options.limit ?? ARTICLES_PER_TICK;

  const { data: pending, error: pendingError } = await supabase
    .from('news_articles')
    .select('id, cleaned_title, published_at')
    .eq('processing_status', 'pending')
    .order('published_at', { ascending: true })
    .limit(limit);

  if (pendingError) throw new Error(`미처리 기사 조회 실패: ${pendingError.message}`);
  const articles = (pending ?? []) as ClusterableArticle[];
  if (articles.length === 0) {
    return { articles: 0, attachedToExisting: 0, newEvents: 0, links: 0 };
  }

  const recentEvents = await fetchRecentEvents(supabase);

  const leftovers: ClusterableArticle[] = [];
  const links: Array<{
    event_id: string;
    article_id: string;
    is_primary: boolean;
    similarity: number;
  }> = [];
  let attachedToExisting = 0;

  for (const article of articles) {
    const match = bestExistingEvent(article, recentEvents);
    if (match) {
      links.push({
        event_id: match.event.id,
        article_id: article.id,
        is_primary: false,
        similarity: match.similarity,
      });
      attachedToExisting++;
    } else {
      leftovers.push(article);
    }
  }

  const clusters = clusterArticles(leftovers);
  let newEvents = 0;

  for (const cluster of clusters) {
    const { data: created, error: eventError } = await supabase
      .from('events')
      .insert({
        title: cluster.primary.cleaned_title,
        status: 'candidate',
        event_occurred_at: cluster.primary.published_at,
        cluster_key: titleHash(cluster.primary.cleaned_title),
      })
      .select('id')
      .single();

    if (eventError || !created) {
      log.warn('이벤트 생성 실패', { title: cluster.primary.cleaned_title, err: eventError?.message });
      continue;
    }
    newEvents++;

    cluster.members.forEach((member, index) => {
      links.push({
        event_id: created.id,
        article_id: member.id,
        is_primary: member.id === cluster.primary.id,
        similarity: cluster.similarities[index] ?? 1,
      });
    });
  }

  if (links.length > 0) {
    const { error: linkError } = await supabase
      .from('event_articles')
      .upsert(links, { onConflict: 'event_id,article_id', ignoreDuplicates: true });
    if (linkError) throw new Error(`기사-이벤트 연결 실패: ${linkError.message}`);
  }

  const { error: statusError } = await supabase
    .from('news_articles')
    .update({ processing_status: 'clustered' })
    .in(
      'id',
      articles.map((a) => a.id),
    );
  if (statusError) throw new Error(`기사 상태 갱신 실패: ${statusError.message}`);

  return { articles: articles.length, attachedToExisting, newEvents, links: links.length };
}

/** 아직 분석이 끝나지 않았거나 최근에 만들어진 이벤트만 병합 대상으로 본다. */
async function fetchRecentEvents(supabase: ServiceClient): Promise<RecentEvent[]> {
  const cutoff = new Date(Date.now() - MAX_HOURS_APART * 3_600_000).toISOString();
  const { data, error } = await supabase
    .from('events')
    .select('id, title, event_occurred_at')
    .gte('event_occurred_at', cutoff)
    .in('status', ['candidate', 'analyzing', 'analyzed', 'pending_review'])
    .order('event_occurred_at', { ascending: false })
    .limit(200);

  if (error) throw new Error(`최근 이벤트 조회 실패: ${error.message}`);
  return (data ?? []).filter((e): e is RecentEvent => e.event_occurred_at !== null);
}

function bestExistingEvent(
  article: ClusterableArticle,
  events: RecentEvent[],
): { event: RecentEvent; similarity: number } | null {
  let best: { event: RecentEvent; similarity: number } | null = null;

  for (const event of events) {
    const verdict = evaluateMerge(
      { title: article.cleaned_title, publishedAt: article.published_at },
      { title: event.title, publishedAt: event.event_occurred_at },
    );
    if (verdict.merge && (!best || verdict.similarity > best.similarity)) {
      best = { event, similarity: verdict.similarity };
    }
  }
  return best;
}
