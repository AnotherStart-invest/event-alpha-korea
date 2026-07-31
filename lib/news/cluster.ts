import { jaccard, tokenize } from './normalize';

/**
 * 뉴스 클러스터링 — 동일 사건 묶기.
 *
 * 설계 원칙(RISK §4.1): **과잉 병합이 과소 병합보다 훨씬 나쁘다.**
 * 서로 다른 사건이 한 이벤트로 합쳐지면 전파 경로와 종목이 통째로 오염된다.
 * 그래서 세 조건을 **모두** 만족할 때만 병합한다.
 *
 *   1) 자카드 유사도 >= SIMILARITY_THRESHOLD
 *   2) 공유 토큰 수   >= MIN_SHARED_TOKENS
 *   3) 발행시각 차이  <= MAX_HOURS_APART
 *
 * MVP 는 임베딩 없이 토큰 유사도만 쓴다. 임베딩 유사도는 비용과 저장공간을
 * 소모하는 데다, 보수적 병합이 목표라면 토큰 일치가 더 안전한 신호다.
 * (문서상 cosine 0.88 기준은 임베딩 경로를 켤 때 적용한다)
 */

export const SIMILARITY_THRESHOLD = 0.45;
export const MIN_SHARED_TOKENS = 2;
export const MAX_HOURS_APART = 24;

export type ClusterableArticle = {
  id: string;
  cleaned_title: string;
  published_at: string;
};

export type MergeVerdict = {
  merge: boolean;
  similarity: number;
  sharedCount: number;
  hoursApart: number;
  reason: string;
};

export function hoursBetween(a: string, b: string): number {
  return Math.abs(new Date(a).getTime() - new Date(b).getTime()) / 3_600_000;
}

export function evaluateMerge(
  left: { title: string; publishedAt: string },
  right: { title: string; publishedAt: string },
): MergeVerdict {
  const leftTokens = tokenize(left.title);
  const rightTokens = tokenize(right.title);
  const rightSet = new Set(rightTokens);

  const similarity = jaccard(leftTokens, rightTokens);
  const sharedCount = leftTokens.filter((t) => rightSet.has(t)).length;
  const hoursApart = hoursBetween(left.publishedAt, right.publishedAt);

  if (hoursApart > MAX_HOURS_APART) {
    return { merge: false, similarity, sharedCount, hoursApart, reason: 'too_far_apart' };
  }
  if (sharedCount < MIN_SHARED_TOKENS) {
    return { merge: false, similarity, sharedCount, hoursApart, reason: 'few_shared_tokens' };
  }
  if (similarity < SIMILARITY_THRESHOLD) {
    return { merge: false, similarity, sharedCount, hoursApart, reason: 'low_similarity' };
  }
  return { merge: true, similarity, sharedCount, hoursApart, reason: 'merged' };
}

export type Cluster = {
  /** 가장 먼저 발행된 기사. 이벤트 제목과 시각의 기준이 된다. */
  primary: ClusterableArticle;
  members: ClusterableArticle[];
  /** primary 대비 유사도. primary 자신은 1 */
  similarities: number[];
};

/**
 * 배치 안에서 기사들을 묶는다.
 *
 * 탐욕적 단일 패스: 각 기사를 기존 클러스터의 **primary** 와만 비교한다.
 * 체인 병합(A~B, B~C 이므로 A~C)을 허용하지 않아 클러스터가 번지는 것을 막는다.
 */
export function clusterArticles(articles: ClusterableArticle[]): Cluster[] {
  const sorted = [...articles].sort(
    (a, b) => new Date(a.published_at).getTime() - new Date(b.published_at).getTime(),
  );

  const clusters: Cluster[] = [];

  for (const article of sorted) {
    let best: { cluster: Cluster; similarity: number } | null = null;

    for (const cluster of clusters) {
      const verdict = evaluateMerge(
        { title: article.cleaned_title, publishedAt: article.published_at },
        { title: cluster.primary.cleaned_title, publishedAt: cluster.primary.published_at },
      );
      if (verdict.merge && (!best || verdict.similarity > best.similarity)) {
        best = { cluster, similarity: verdict.similarity };
      }
    }

    if (best) {
      best.cluster.members.push(article);
      best.cluster.similarities.push(best.similarity);
    } else {
      clusters.push({ primary: article, members: [article], similarities: [1] });
    }
  }

  return clusters;
}
