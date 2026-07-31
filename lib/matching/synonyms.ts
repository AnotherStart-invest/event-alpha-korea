import 'server-only';
import type { ServiceClient } from '@/lib/db/service';
import { normalizeTerm } from './normalize';

/**
 * 동의어 확장.
 *
 * 한국어에는 형태소 분석기가 없으므로(RISK §4.2) 동의어 사전이 매칭 품질의
 * 상당 부분을 결정한다. "변압기 / transformer / 초고압변압기" 가 이어지지
 * 않으면 매칭이 그냥 실패한다.
 */
export type ExpandedKeyword = {
  /** 원본 이벤트 키워드 */
  source: string;
  /** 검색에 쓸 표현 (원본 포함) */
  terms: string[];
};

export async function expandKeywords(
  supabase: ServiceClient,
  keywords: string[],
): Promise<ExpandedKeyword[]> {
  if (keywords.length === 0) return [];

  const { data, error } = await supabase.from('synonyms').select('term, alias');
  if (error) throw new Error(`동의어 조회 실패: ${error.message}`);

  // alias → term, term → alias 양방향 인덱스
  const graph = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    const key = normalizeTerm(a);
    if (!key) return;
    if (!graph.has(key)) graph.set(key, new Set());
    graph.get(key)!.add(b);
  };

  for (const row of data ?? []) {
    link(row.alias, row.term);
    link(row.term, row.alias);
  }

  return keywords.map((source) => {
    const related = graph.get(normalizeTerm(source));
    const terms = related ? [source, ...related] : [source];
    return { source, terms: Array.from(new Set(terms)) };
  });
}

/** 확장 결과를 (정규형 → 원본 키워드) 조회표로 만든다. */
export function buildLookup(expanded: ExpandedKeyword[]): Map<string, { source: string; isSynonym: boolean }> {
  const lookup = new Map<string, { source: string; isSynonym: boolean }>();
  for (const entry of expanded) {
    for (const term of entry.terms) {
      const key = normalizeTerm(term);
      if (!key || lookup.has(key)) continue;
      lookup.set(key, { source: entry.source, isSynonym: normalizeTerm(term) !== normalizeTerm(entry.source) });
    }
  }
  return lookup;
}
