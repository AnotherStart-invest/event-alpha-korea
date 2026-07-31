import 'server-only';
import { z } from 'zod';
import { required } from '@/lib/shared/env';
import { UpstreamError, withRetry } from '@/lib/shared/errors';
import { cleanTitle, guessSourceName, parsePubDate, stripHtml, titleHash } from './normalize';

const ENDPOINT = 'https://openapi.naver.com/v1/search/news.json';

/** 네이버 검색 API 응답 (문서화된 필드만) */
const naverItemSchema = z.object({
  title: z.string(),
  originallink: z.string().optional().default(''),
  link: z.string().optional().default(''),
  description: z.string().optional().default(''),
  pubDate: z.string(),
});

const naverResponseSchema = z.object({
  total: z.number().optional().default(0),
  start: z.number().optional().default(1),
  display: z.number().optional().default(0),
  items: z.array(naverItemSchema).default([]),
});

/** 파이프라인 내부 표현. news_articles 컬럼과 1:1 대응한다. */
export type CollectedArticle = {
  title: string;
  cleaned_title: string;
  description: string | null;
  source_name: string | null;
  original_url: string | null;
  naver_url: string | null;
  published_at: string;
  query_keyword: string;
  title_hash: string;
};

export type SearchOptions = {
  /** 최대 100 */
  display?: number;
  /** 1~1000 */
  start?: number;
  /** 이 시각보다 오래된 기사는 버린다 */
  since?: Date;
};

/**
 * 네이버 뉴스 검색.
 *
 * 알려진 제약(RISK §2.1):
 * - display 최대 100, start 최대 1000
 * - originallink 가 빈 문자열인 경우가 있어 link 로 폴백
 * - description 에 <b> 태그와 HTML 엔티티가 섞여 온다
 * - sort=date 가 발행순을 보장하지 않는다
 */
export async function searchNews(
  keyword: string,
  options: SearchOptions = {},
): Promise<CollectedArticle[]> {
  const clientId = required('NAVER_CLIENT_ID');
  const clientSecret = required('NAVER_CLIENT_SECRET');

  const url = new URL(ENDPOINT);
  url.searchParams.set('query', keyword);
  url.searchParams.set('display', String(Math.min(options.display ?? 50, 100)));
  url.searchParams.set('start', String(Math.min(Math.max(options.start ?? 1, 1), 1000)));
  url.searchParams.set('sort', 'date');

  const payload = await withRetry(async () => {
    const response = await fetch(url, {
      headers: {
        'X-Naver-Client-Id': clientId,
        'X-Naver-Client-Secret': clientSecret,
      },
      cache: 'no-store',
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new UpstreamError(
        `네이버 뉴스 검색 실패 (${response.status}): ${body.slice(0, 200)}`,
        response.status,
      );
    }
    return naverResponseSchema.parse(await response.json());
  });

  return payload.items
    .map((item) => toArticle(item, keyword))
    .filter((article): article is CollectedArticle => article !== null)
    .filter((article) => !options.since || new Date(article.published_at) >= options.since);
}

function toArticle(
  item: z.infer<typeof naverItemSchema>,
  keyword: string,
): CollectedArticle | null {
  const publishedAt = parsePubDate(item.pubDate);
  if (!publishedAt) return null;

  const title = stripHtml(item.title).trim();
  if (!title) return null;

  const cleaned = cleanTitle(item.title);
  if (!cleaned) return null;

  const originalUrl = item.originallink?.trim() || null;
  const naverUrl = item.link?.trim() || null;

  return {
    title,
    cleaned_title: cleaned,
    // 네이버가 제공한 발췌만 저장한다. 본문은 수집하지 않는다 (저작권 원칙 I7).
    description: stripHtml(item.description).trim() || null,
    source_name: guessSourceName(originalUrl ?? naverUrl),
    original_url: originalUrl ?? naverUrl,
    naver_url: naverUrl,
    published_at: publishedAt,
    query_keyword: keyword,
    title_hash: titleHash(cleaned),
  };
}

/**
 * 같은 배치 안의 중복 제거.
 * DB 의 unique(title_hash, published_at) 로도 걸리지만,
 * 먼저 줄여야 upsert 페이로드가 작아진다.
 */
export function dedupeBatch(articles: CollectedArticle[]): CollectedArticle[] {
  const seen = new Map<string, CollectedArticle>();
  for (const article of articles) {
    const key = `${article.title_hash}:${article.published_at}`;
    if (!seen.has(key)) seen.set(key, article);
  }
  return Array.from(seen.values());
}
