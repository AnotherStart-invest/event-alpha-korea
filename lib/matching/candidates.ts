import 'server-only';
import type { ServiceClient } from '@/lib/db/service';
import type { Logger } from '@/lib/shared/logger';
import { embedTexts } from '@/lib/llm';
import { cleanKeywords, isFuzzySearchable, normalizeTerm } from './normalize';
import { buildLookup, expandKeywords } from './synonyms';
import type { Candidate, EventQuery, MatchKind, MatchedExposure } from './types';

/**
 * 후보 생성 — **완전히 결정론적이다. LLM 이 개입하지 않는다.**
 *
 * 이것이 "AI 가 종목을 지어내지 못하게" 하는 구조적 장치의 앞쪽 절반이다.
 * 뒤쪽 절반은 lib/matching/impacts.ts 의 집합 멤버십 검증이다.
 */
export const MAX_CANDIDATES = 100;
const EMBEDDING_THRESHOLD = 0.72;

/**
 * 키워드 하나가 끌고 올 수 있는 기업 수 상한. 이보다 많으면 변별력이 없다고 보고 버린다.
 *
 * 실측 근거: "타이어" 3개 / "철강" 14개는 남아야 하고 "반도체" 72개는 버려야 한다.
 * 광범위한 산업명 하나가 소부장 수십 개를 통째로 끌고 오면 점수가 20~35에 뭉쳐
 * 순위가 무의미해지고, 화면은 "관련 없는 종목 목록"이 된다.
 *
 * **기업이 아니라 키워드를 버린다.** 같은 기업이 더 좁은 키워드로도 걸렸다면
 * 그 근거로는 그대로 남는다 (예: "반도체"는 버려도 "메모리 반도체"는 살아남는다).
 */
export const MAX_COMPANIES_PER_TERM = 15;

/** 매칭 기업이 너무 많아 변별력이 없는 키워드를 골라낸다. */
export function findBroadTerms(
  hits: Iterable<{ companyId: string; keyword: string }>,
  max = MAX_COMPANIES_PER_TERM,
): Set<string> {
  const byKeyword = new Map<string, Set<string>>();
  for (const hit of hits) {
    let companies = byKeyword.get(hit.keyword);
    if (!companies) byKeyword.set(hit.keyword, (companies = new Set()));
    companies.add(hit.companyId);
  }

  const broad = new Set<string>();
  for (const [keyword, companies] of byKeyword) {
    if (companies.size > max) broad.add(keyword);
  }
  return broad;
}

type ExposureRow = {
  id: string;
  company_id: string;
  exposure_type: string;
  exposure_value: string;
  normalized_value: string;
  revenue_share: number | null;
  geography: string | null;
  direction: string | null;
  verified: boolean;
  source_evidence_id: string | null;
};

export async function findCandidates(
  supabase: ServiceClient,
  query: EventQuery,
  log: Logger,
  options: { useEmbedding?: boolean; limit?: number } = {},
): Promise<Candidate[]> {
  const limit = options.limit ?? MAX_CANDIDATES;

  const keywords = cleanKeywords([
    ...query.products,
    ...query.rawMaterials,
    ...query.industries,
    ...query.customerGroups,
    ...query.geography,
  ]);
  if (keywords.length === 0) return [];

  const expanded = await expandKeywords(supabase, keywords);
  const lookup = buildLookup(expanded);
  const allTerms = expanded.flatMap((e) => e.terms);
  const normalizedTerms = Array.from(new Set(allTerms.map(normalizeTerm))).filter(Boolean);

  /** exposure_id → 매칭 정보. 같은 exposure 가 여러 경로로 걸리면 더 강한 쪽을 남긴다. */
  const hits = new Map<string, { row: ExposureRow; kind: MatchKind; similarity: number | null; keyword: string }>();

  const record = (
    row: ExposureRow,
    kind: MatchKind,
    keyword: string,
    similarity: number | null = null,
  ) => {
    const existing = hits.get(row.id);
    if (existing && rank(existing.kind) >= rank(kind)) return;
    hits.set(row.id, { row, kind, similarity, keyword });
  };

  // 1) 정확 일치 + 동의어 — 가장 신뢰도 높은 경로
  const exact = await fetchExposures(supabase, (q) => q.in('normalized_value', normalizedTerms));
  for (const row of exact) {
    const match = lookup.get(row.normalized_value);
    if (!match) continue;
    record(row, match.isSynonym ? 'synonym' : 'exact', match.source);
  }
  log.debug('정확·동의어 매칭', { count: exact.length });

  // 2) 부분 일치 (pg_trgm). 짧은 한글은 오탐이 심해 3자 이상만 시도한다.
  const fuzzyTerms = allTerms.filter(isFuzzySearchable).slice(0, 12);
  for (const term of fuzzyTerms) {
    const rows = await fetchExposures(supabase, (q) => q.ilike('exposure_value', `%${term}%`).limit(40));
    const source = lookup.get(normalizeTerm(term))?.source ?? term;
    for (const row of rows) record(row, 'fulltext', source);
  }

  // 3) 임베딩 유사도 — 표기가 전혀 다른 경우를 잡는다
  if (options.useEmbedding !== false) {
    try {
      const probes = [...query.products, ...query.rawMaterials].slice(0, 3);
      if (probes.length > 0) {
        const vectors = await embedTexts(supabase, probes);
        for (let i = 0; i < vectors.length; i++) {
          const { data, error } = await supabase.rpc('match_exposures', {
            p_embedding: JSON.stringify(vectors[i]),
            p_threshold: EMBEDDING_THRESHOLD,
            p_limit: 40,
          });
          if (error) {
            log.warn('임베딩 검색 실패', { err: error.message });
            break;
          }
          const ids = (data ?? []).map((d) => d.exposure_id);
          if (ids.length === 0) continue;
          const rows = await fetchExposures(supabase, (q) => q.in('id', ids));
          const simById = new Map((data ?? []).map((d) => [d.exposure_id, d.similarity]));
          for (const row of rows) record(row, 'embedding', probes[i], simById.get(row.id) ?? null);
        }
      }
    } catch (err) {
      // 임베딩은 있으면 좋은 보조 경로다. 실패해도 파이프라인을 멈추지 않는다.
      log.warn('임베딩 후보 생성 생략', { err: err instanceof Error ? err.message : String(err) });
    }
  }

  if (hits.size === 0) return [];

  // 변별력 없는 광범위 키워드를 버린다. 종목이 아니라 키워드 단위로 버리므로
  // 더 좁은 키워드로도 걸린 기업은 그대로 남는다.
  const broadTerms = findBroadTerms(
    Array.from(hits.values(), (h) => ({ companyId: h.row.company_id, keyword: h.keyword })),
  );
  if (broadTerms.size > 0) {
    for (const [id, hit] of hits) {
      if (broadTerms.has(hit.keyword)) hits.delete(id);
    }
    log.info('광범위 키워드 제외', { terms: Array.from(broadTerms).join(', '), remaining: hits.size });
    if (hits.size === 0) return [];
  }

  const companyIds = Array.from(new Set(Array.from(hits.values()).map((h) => h.row.company_id)));
  const [companies, evidence] = await Promise.all([
    fetchCompanies(supabase, companyIds),
    fetchEvidence(
      supabase,
      Array.from(hits.values())
        .map((h) => h.row.source_evidence_id)
        .filter((id): id is string => id !== null),
    ),
  ]);

  const byCompany = new Map<string, Candidate>();
  for (const hit of hits.values()) {
    const company = companies.get(hit.row.company_id);
    // 종목코드 없는 기업은 여기서 미리 떨어뜨린다 (R1)
    if (!company || !company.stock_code) continue;

    if (!byCompany.has(company.id)) {
      byCompany.set(company.id, {
        companyId: company.id,
        companyName: company.company_name,
        stockCode: company.stock_code,
        market: company.market,
        industryName: company.industry_name,
        latestReportDate: company.latest_report_date,
        exposures: [],
      });
    }

    const ev = hit.row.source_evidence_id ? evidence.get(hit.row.source_evidence_id) : undefined;
    byCompany.get(company.id)!.exposures.push({
      id: hit.row.id,
      exposureType: hit.row.exposure_type as MatchedExposure['exposureType'],
      exposureValue: hit.row.exposure_value,
      normalizedValue: hit.row.normalized_value,
      revenueShare: hit.row.revenue_share,
      geography: hit.row.geography,
      direction: hit.row.direction as MatchedExposure['direction'],
      verified: hit.row.verified,
      evidenceId: hit.row.source_evidence_id,
      evidenceSourceType: (ev?.source_type as MatchedExposure['evidenceSourceType']) ?? null,
      evidenceVerified: hit.row.verified,
      matchKind: hit.kind,
      similarity: hit.similarity,
      matchedKeyword: hit.keyword,
    });
  }

  const candidates = Array.from(byCompany.values());
  log.info('후보 생성 완료', { exposures: hits.size, companies: candidates.length });

  // 노출 수가 많은 기업을 우선해 상한을 넘지 않게 자른다.
  return candidates.sort((a, b) => b.exposures.length - a.exposures.length).slice(0, limit);
}

function rank(kind: MatchKind): number {
  switch (kind) {
    case 'exact':
      return 5;
    case 'synonym':
      return 4;
    case 'embedding':
      return 3;
    case 'fulltext':
      return 2;
    case 'relation':
      return 1;
  }
}

type ExposureQuery = ReturnType<ServiceClient['from']> extends never ? never : unknown;

async function fetchExposures(
  supabase: ServiceClient,
  build: (q: ReturnType<typeof baseExposureQuery>) => unknown,
): Promise<ExposureRow[]> {
  const query = baseExposureQuery(supabase);
  const result = (await build(query)) as { data: ExposureRow[] | null; error: { message: string } | null };
  if (result.error) throw new Error(`노출 조회 실패: ${result.error.message}`);
  return result.data ?? [];
}

function baseExposureQuery(supabase: ServiceClient) {
  return supabase
    .from('company_exposures')
    .select(
      'id, company_id, exposure_type, exposure_value, normalized_value, revenue_share, geography, direction, verified, source_evidence_id',
    );
}

async function fetchCompanies(supabase: ServiceClient, ids: string[]) {
  const map = new Map<
    string,
    {
      id: string;
      company_name: string;
      stock_code: string | null;
      market: string | null;
      industry_name: string | null;
      latest_report_date: string | null;
    }
  >();
  if (ids.length === 0) return map;

  const { data, error } = await supabase
    .from('companies')
    .select('id, company_name, stock_code, market, industry_name, latest_report_date')
    .in('id', ids);
  if (error) throw new Error(`기업 조회 실패: ${error.message}`);

  for (const row of data ?? []) map.set(row.id, row);
  return map;
}

async function fetchEvidence(supabase: ServiceClient, ids: string[]) {
  const map = new Map<string, { id: string; source_type: string; source_title: string; excerpt: string | null; source_date: string | null; source_url: string | null }>();
  const unique = Array.from(new Set(ids));
  if (unique.length === 0) return map;

  const { data, error } = await supabase
    .from('evidence_sources')
    .select('id, source_type, source_title, excerpt, source_date, source_url')
    .in('id', unique);
  if (error) throw new Error(`근거 조회 실패: ${error.message}`);

  for (const row of data ?? []) map.set(row.id, row);
  return map;
}

export { fetchEvidence };
export type { ExposureQuery };
