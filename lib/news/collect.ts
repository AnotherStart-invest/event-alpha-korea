import 'server-only';
import type { ServiceClient } from '@/lib/db/service';
import type { Logger } from '@/lib/shared/logger';
import { errorMessage } from '@/lib/shared/errors';
import { dedupeBatch, searchNews, type CollectedArticle } from './naver';
import { judgeEconomic } from './relevance';

/**
 * 한 tick 에서 처리할 키워드 수 상한.
 * Vercel 함수 시간 제한을 넘기지 않기 위한 장치이며, 남은 키워드는
 * last_run_at 라운드로빈으로 다음 tick 이 이어받는다 (ARCHITECTURE §4.1).
 *
 * 키워드 1개 = 네이버 API 1회 호출이므로 이 값이 곧 무료 할당량 소모율이다.
 * cron 주기(.github/workflows/cron.yml)와 곱해서 하루 호출량을 잡는다.
 */
export const KEYWORDS_PER_TICK = 8;

/** 이 시간보다 오래된 기사는 수집하지 않는다. */
export const LOOKBACK_HOURS = 24;

export type CollectStats = {
  keywords: number;
  fetched: number;
  unique: number;
  inserted: number;
  failedKeywords: number;
  /** 경제 기사가 아니라 버린 건수 (lib/news/relevance.ts) */
  droppedNonEconomic: number;
};

export async function collectNews(
  supabase: ServiceClient,
  log: Logger,
  options: { limit?: number; keyword?: string } = {},
): Promise<CollectStats> {
  const keywords = options.keyword
    ? [{ id: null as string | null, keyword: options.keyword }]
    : await pickKeywords(supabase, options.limit ?? KEYWORDS_PER_TICK);

  const since = new Date(Date.now() - LOOKBACK_HOURS * 3600_000);
  const collected: CollectedArticle[] = [];
  let failedKeywords = 0;

  for (const entry of keywords) {
    try {
      const articles = await searchNews(entry.keyword, { display: 50, since });
      collected.push(...articles);
      log.debug('키워드 수집', { keyword: entry.keyword, count: articles.length });
    } catch (err) {
      failedKeywords++;
      log.warn('키워드 수집 실패', { keyword: entry.keyword, err: errorMessage(err) });
    } finally {
      if (entry.id) {
        await supabase
          .from('watch_keywords')
          .update({ last_run_at: new Date().toISOString() })
          .eq('id', entry.id);
      }
    }
  }

  const unique = dedupeBatch(collected);

  // 경제와 무관한 기사를 여기서 끊는다. 네이버 검색 API 에는 분야 파라미터가 없어서
  // "가동 중단" 같은 일반어가 폭염·사건사고 기사를 대량으로 끌고 온다.
  const economic = unique.filter((article) => {
    const verdict = judgeEconomic(article.title);
    if (!verdict.economic) {
      log.debug('비경제 기사 제외', { title: article.title.slice(0, 40), reason: verdict.reason });
    }
    return verdict.economic;
  });

  const inserted = await upsertArticles(supabase, economic);

  return {
    keywords: keywords.length,
    fetched: collected.length,
    unique: unique.length,
    inserted,
    failedKeywords,
    droppedNonEconomic: unique.length - economic.length,
  };
}

/** priority 높은 순 → 오래 안 돈 순. last_run_at 이 라운드로빈 커서다. */
async function pickKeywords(
  supabase: ServiceClient,
  limit: number,
): Promise<Array<{ id: string; keyword: string }>> {
  const { data, error } = await supabase
    .from('watch_keywords')
    .select('id, keyword')
    .eq('active', true)
    .order('priority', { ascending: true })
    .order('last_run_at', { ascending: true, nullsFirst: true })
    .limit(limit);

  if (error) throw new Error(`감시 키워드 조회 실패: ${error.message}`);
  return data ?? [];
}

/**
 * 멱등 저장.
 * unique(title_hash, published_at) 위반은 무시한다 → 재실행해도 행이 늘지 않는다.
 * ignoreDuplicates 를 쓰면 기존 행의 processing_status 를 덮어쓰지 않는다는 점이 중요하다.
 */
async function upsertArticles(
  supabase: ServiceClient,
  articles: CollectedArticle[],
): Promise<number> {
  if (articles.length === 0) return 0;

  const { data, error } = await supabase
    .from('news_articles')
    .upsert(articles, { onConflict: 'title_hash,published_at', ignoreDuplicates: true })
    .select('id');

  if (error) throw new Error(`기사 저장 실패: ${error.message}`);
  return data?.length ?? 0;
}
