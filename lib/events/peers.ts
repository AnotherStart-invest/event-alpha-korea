import 'server-only';
import type { ServiceClient } from '@/lib/db/service';
import type { EventStatus } from '@/lib/db/enums';
import type { ScoreBreakdown } from '@/lib/db/types';
import type { Logger } from '@/lib/shared/logger';
import { hasMentionAnchor } from './anchor';
import {
  type PeerCompany,
  type PeerExposure,
  type PeerPick,
  peerScore,
  selectPeers,
} from '@/lib/matching/peers';

/**
 * 이벤트에 이미 붙은 종목과 **같은 주요제품을 파는 상장사**를 추가로 붙인다.
 * LLM 을 한 번도 부르지 않는다.
 *
 * 기사 언급 매칭(mentions.ts)만으로는 이벤트당 1~3종목이 한계다. 기사가 이름을
 * 말한 종목만 잡히기 때문이다. 하지만 타이어 해상운임이 오르면 기사에 안 나온
 * 한국타이어도 같은 변수를 맞는다. 그 한 발을 여기서 뻗는다.
 *
 * 방향(긍정·부정)은 판정하지 않는다. 씨앗 종목과 방향이 같다고 단정할 수 없다 —
 * 같은 제품군이라도 원가 구조와 환헤지가 달라 반대로 움직이는 일이 흔하다.
 */

export type PeerStats = {
  events: number;
  seeds: number;
  impacts: number;
  skippedNoSeed: number;
  published: number;
};

/** 동종 확장 대상 상태. rejected·failed 는 건드리지 않는다. */
const TARGET_STATUSES: EventStatus[] = ['candidate', 'analyzed', 'pending_review', 'published'];

/**
 * 씨앗으로 쓸 최소 점수. 약한 근거로 붙은 종목에서 또 한 발을 뻗으면
 * 근거가 두 단계 희석된 종목이 화면에 올라온다.
 */
const MIN_SEED_SCORE = 40;

type EventRow = { id: string; status: EventStatus };

type ImpactRow = {
  company_id: string;
  relevance_score: number;
  score_breakdown: ScoreBreakdown | null;
};

type CompanyRow = {
  id: string;
  company_name: string;
  stock_code: string | null;
  industry_name: string | null;
};

export async function linkPeerCompanies(
  supabase: ServiceClient,
  log: Logger,
  options: { limit?: number; eventIds?: string[] } = {},
): Promise<PeerStats> {
  const stats: PeerStats = { events: 0, seeds: 0, impacts: 0, skippedNoSeed: 0, published: 0 };

  const { data: settings } = await supabase
    .from('app_settings')
    .select('peers_enabled, auto_publish')
    .eq('id', 1)
    .maybeSingle();

  if (settings?.peers_enabled === false) {
    log.info('동종 확장이 꺼져 있음');
    return stats;
  }

  const events = await loadEvents(supabase, options);
  log.info('대상 이벤트', { count: events.length });

  for (const event of events) {
    const impacts = await loadImpacts(supabase, event.id);
    if (impacts.length === 0) continue;

    // 동종 확장으로 붙은 종목은 씨앗이 될 수 없다. 그러지 않으면
    // 제품 그래프를 따라 무한히 번진다.
    const seedIds = impacts
      .filter((i) => i.score_breakdown?.peer === undefined && i.relevance_score >= MIN_SEED_SCORE)
      .map((i) => i.company_id);

    if (seedIds.length === 0) {
      stats.skippedNoSeed++;
      continue;
    }

    const seeds = await loadSeeds(supabase, seedIds);
    const seedExposures = await loadProductExposures(supabase, seedIds);
    if (seedExposures.length === 0) continue;

    const terms = Array.from(new Set(seedExposures.map((e) => e.normalizedValue)));
    const companiesByTerm = await loadCompaniesByTerm(supabase, terms);

    const picks = selectPeers(seeds, seedExposures, companiesByTerm, {
      exclude: new Set(impacts.map((i) => i.company_id)),
    });
    if (picks.length === 0) continue;

    const companies = await loadCompanies(supabase, picks.map((p) => p.companyId));
    // 종목코드 없는 기업은 여기서 떨어뜨린다 (R1).
    const usable = picks.filter((p) => companies.get(p.companyId)?.stock_code);
    if (usable.length === 0) continue;

    stats.events++;
    stats.seeds += seedIds.length;
    stats.impacts += await insertImpacts(supabase, event.id, usable);

    // 동종 확장은 씨앗을 한 발 넓힌 것뿐이라 그 자체로 기사에 앵커되지 않는다.
    if (
      settings?.auto_publish &&
      event.status !== 'published' &&
      (await hasMentionAnchor(supabase, event.id))
    ) {
      await publish(supabase, event.id);
      stats.published++;
    }
  }

  log.info('동종 확장 완료', { ...stats });
  return stats;
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

async function loadImpacts(supabase: ServiceClient, eventId: string): Promise<ImpactRow[]> {
  const { data, error } = await supabase
    .from('event_impacts')
    .select('company_id, relevance_score, score_breakdown')
    .eq('event_id', eventId);
  if (error) throw new Error(`기존 영향 조회 실패: ${error.message}`);
  return (data ?? []) as ImpactRow[];
}

async function loadSeeds(supabase: ServiceClient, ids: string[]): Promise<Map<string, PeerCompany>> {
  const companies = await loadCompanies(supabase, ids);
  return new Map(
    Array.from(companies.values(), (c) => [
      c.id,
      { companyId: c.id, companyName: c.company_name, industryName: c.industry_name },
    ]),
  );
}

async function loadCompanies(supabase: ServiceClient, ids: string[]): Promise<Map<string, CompanyRow>> {
  const map = new Map<string, CompanyRow>();
  if (ids.length === 0) return map;

  const { data, error } = await supabase
    .from('companies')
    .select('id, company_name, stock_code, industry_name')
    .in('id', ids);
  if (error) throw new Error(`기업 조회 실패: ${error.message}`);
  for (const row of data ?? []) map.set(row.id, row as CompanyRow);
  return map;
}

/** 씨앗 종목의 제품 노출. 제품 계열만 쓴다 — 지역·정책은 동종 판단 근거가 못 된다. */
async function loadProductExposures(supabase: ServiceClient, ids: string[]): Promise<PeerExposure[]> {
  const { data, error } = await supabase
    .from('company_exposures')
    .select('company_id, normalized_value, exposure_value')
    .in('company_id', ids)
    .in('exposure_type', ['product', 'raw_material', 'commodity']);
  if (error) throw new Error(`노출 조회 실패: ${error.message}`);

  return (data ?? []).map((row) => ({
    companyId: row.company_id,
    normalizedValue: row.normalized_value,
    exposureValue: row.exposure_value,
  }));
}

/**
 * 제품 용어별 보유 상장사.
 *
 * is_listed 필터가 중요하다. companies 에는 상장폐지 법인이 1,200여 건 섞여 있고
 * 그것들이 용어별 기업 수를 부풀리면 변별력 판정이 어긋난다.
 */
async function loadCompaniesByTerm(
  supabase: ServiceClient,
  terms: string[],
): Promise<Map<string, PeerCompany[]>> {
  const byTerm = new Map<string, PeerCompany[]>();
  if (terms.length === 0) return byTerm;

  const CHUNK = 100;
  for (let i = 0; i < terms.length; i += CHUNK) {
    const { data, error } = await supabase
      .from('company_exposures')
      .select('normalized_value, companies!inner(id, company_name, industry_name, is_listed, stock_code)')
      .in('normalized_value', terms.slice(i, i + CHUNK))
      .eq('companies.is_listed', true)
      .not('companies.stock_code', 'is', null);
    if (error) throw new Error(`용어별 기업 조회 실패: ${error.message}`);

    type JoinedCompany = { id: string; company_name: string; industry_name: string | null };
    type Joined = { normalized_value: string; companies: JoinedCompany | JoinedCompany[] | null };

    for (const row of (data ?? []) as unknown as Joined[]) {
      const company = Array.isArray(row.companies) ? row.companies[0] : row.companies;
      if (!company) continue;
      let list = byTerm.get(row.normalized_value);
      if (!list) byTerm.set(row.normalized_value, (list = []));
      if (list.some((c) => c.companyId === company.id)) continue;
      list.push({
        companyId: company.id,
        companyName: company.company_name,
        industryName: company.industry_name,
      });
    }
  }
  return byTerm;
}

/* ── 쓰기 ─────────────────────────────────────────────── */

/**
 * 동종 확장으로 받은 점수. 다른 항목은 전부 0 이다 — 이 종목의 매출·공시를
 * 확인한 적이 없다. 확인한 것은 "같은 제품을 판다" 하나뿐이다.
 */
function breakdown(pick: PeerPick): ScoreBreakdown {
  const score = peerScore(pick.sharedTerms.length);
  const products = pick.sharedTerms.map((t) => `"${t.exposureValue}"`).join(', ');
  const seeds = Array.from(new Set(pick.sharedTerms.map((t) => t.seedName))).join(', ');
  return {
    product: 0,
    revenue: 0,
    geography: 0,
    supplyChain: 0,
    disclosure: 0,
    recency: 0,
    thematic: 0,
    peer: score,
    total: score,
    notes: [`${seeds} 와(과) 같은 제품군: ${products}`],
  };
}

function rationale(pick: PeerPick): string {
  const products = pick.sharedTerms.map((t) => `"${t.exposureValue}"`).join(', ');
  const seeds = Array.from(new Set(pick.sharedTerms.map((t) => t.seedName))).join(', ');
  return (
    `이 이벤트에 직접 걸린 ${seeds} 와(과) 같은 제품군(${products})을 영위합니다. ` +
    '같은 변수의 영향을 받을 수 있으나, 기사에 직접 언급되지는 않았습니다. ' +
    '영향의 방향과 크기는 판정하지 않았습니다.'
  );
}

async function insertImpacts(
  supabase: ServiceClient,
  eventId: string,
  picks: PeerPick[],
): Promise<number> {
  const { data, error } = await supabase
    .from('event_impacts')
    .upsert(
      picks.map((pick) => {
        const score = peerScore(pick.sharedTerms.length);
        return {
          event_id: eventId,
          company_id: pick.companyId,
          // 같은 제품군이라고 방향까지 같지는 않다.
          impact_direction: 'uncertain' as const,
          impact_level: 'low' as const,
          relation_type: 'competitor' as const,
          relevance_score: score,
          score_breakdown: breakdown(pick),
          confidence_score: null,
          rationale: rationale(pick),
          review_status: 'pending' as const,
          is_manual: false,
        };
      }),
      { onConflict: 'event_id,company_id' },
    )
    .select('id');

  if (error) throw new Error(`동종 종목 저장 실패: ${error.message}`);
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
