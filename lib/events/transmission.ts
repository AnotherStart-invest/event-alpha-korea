import 'server-only';
import type { ServiceClient } from '@/lib/db/service';
import type { EventStatus, ImpactDirection, RelationType } from '@/lib/db/enums';
import type { Logger } from '@/lib/shared/logger';
import { BudgetExceededError, QuotaExceededError, errorMessage } from '@/lib/shared/errors';
import { scanObjectForBanned } from '@/lib/shared/banned-words';
import { callLlm } from '@/lib/llm';
import { transmissionSchema, type TransmissionStep } from '@/lib/llm/schemas';
import { TRANSMISSION_SYSTEM, buildTransmissionUser, type ArticleForPrompt } from '@/lib/llm/prompts';
import { findCandidates } from '@/lib/matching/candidates';
import { hasMentionAnchor } from './anchor';
import { loadMentionDict } from './mentions';
import { resolveCompanyNames } from '@/lib/matching/resolve';
import { applyHardRules, scoreCandidate } from '@/lib/matching/scoring';
import type { Candidate, EventQuery, ScoreBreakdown } from '@/lib/matching/types';

/**
 * 전파 경로를 그리고, 그 경로에 걸리는 종목을 찾는다.
 *
 * 기존 두 경로(mentions, peers)는 LLM 을 안 쓰는 대신 논리가 없다.
 * "기사에 이름이 나왔다", "같은 제품을 판다"는 사실일 뿐 인과가 아니다.
 * 그래서 구조적으로 못 잡는 게 있었다 — **수요 측 종목**이다.
 * 철강값이 떨어지면 철강사는 부정적이지만 철강을 사는 조선·자동차는 수혜인데,
 * 제품 매칭으로는 후자를 영원히 못 찾는다.
 *
 * 종목을 찾는 경로는 두 개이고 **순서가 중요하다.**
 *
 * 1순위 — LLM 이 사업 구조로 지목한 회사(step.companies).
 *   원래 이 시스템은 "LLM 은 기업명을 출력할 수 없다" 를 불변식으로 삼았다.
 *   환각 차단은 됐지만 그 대가로 KRX 주요제품 문자열 매칭이 유일한 다리가 됐고,
 *   그게 품질의 상한이었다 — "소프트웨어 개발"(13개사) 하나로 넷마블과 셀바스AI 가
 *   같이 걸리고, 밸류체인 전·후방은 문자열로 이을 방법이 없었다.
 *   불변식을 **"LLM 은 제안하고 코드가 실존을 검증한다"** 로 바꿨다
 *   (lib/matching/resolve.ts). 없는 종목이 뜨는 일은 여전히 불가능하다.
 *
 * 2순위 — 제품 문자열 매칭(findCandidates).
 *   LLM 이 아무 회사도 못 댄 단계를 메우는 보조 경로다. "왜 이 회사인가" 를
 *   말하지 못하므로 앞자리를 주지 않는다.
 *
 * 이벤트당 LLM 호출은 1회(cheap)다.
 */

export type TransmissionStats = {
  events: number;
  traceable: number;
  steps: number;
  impacts: number;
  upgraded: number;
  skippedNoArticle: number;
  failed: number;
};

/** 전파 경로를 그릴 대상 상태. rejected 는 이미 걸러진 것이라 건드리지 않는다. */
const TARGET_STATUSES: EventStatus[] = ['candidate', 'analyzed', 'pending_review', 'published'];

/** 이벤트 하나에 이 경로로 붙일 수 있는 종목 수 상한. */
const MAX_IMPACTS_PER_EVENT = 20;

/** 한 단계가 끌고 올 수 있는 종목 수 상한. 단계 하나가 화면을 다 먹지 않게. */
const MAX_IMPACTS_PER_STEP = 10;

/**
 * LLM 이 사업 구조로 지목하고 상장사 사전에 실존이 확인된 종목의 점수.
 *
 * 문자열 매칭 최고점(제품 20 + 집중도 20 + 공시 15 = 55 근처)보다 높게 둔다.
 * 근거의 성격이 다르기 때문이다 — 이쪽은 "왜 이 회사인가" 를 사업 구조로 말할 수
 * 있고, 저쪽은 "주요제품 문자열이 겹친다" 가 전부다. 화면에서 앞자리를 차지해야
 * 하는 쪽은 전자다.
 *
 * 만점을 주지 않는 이유: LLM 의 판단이고 공시로 대조한 것이 아니다.
 * 매출 비중·고객사 확인이 붙으면 그때 더 올라가야 한다.
 */
const LLM_NAMED_SCORE = 65;

type EventRow = {
  id: string;
  title: string;
  factual_summary: string | null;
  status: EventStatus;
};

type ExistingImpact = { company_id: string; impact_direction: ImpactDirection };

export async function traceTransmission(
  supabase: ServiceClient,
  log: Logger,
  options: { limit?: number; eventIds?: string[] } = {},
): Promise<TransmissionStats> {
  const stats: TransmissionStats = {
    events: 0,
    traceable: 0,
    steps: 0,
    impacts: 0,
    upgraded: 0,
    skippedNoArticle: 0,
    failed: 0,
  };

  const { data: settings } = await supabase
    .from('app_settings')
    .select('transmission_enabled, auto_publish')
    .eq('id', 1)
    .maybeSingle();

  if (settings?.transmission_enabled === false) {
    log.info('전파 경로 추적이 꺼져 있음');
    return stats;
  }

  const events = await loadEvents(supabase, options);
  log.info('대상 이벤트', { count: events.length });

  for (const event of events) {
    try {
      const outcome = await traceOne(supabase, log, event, settings?.auto_publish ?? false);
      stats.events++;
      if (outcome.traceable) stats.traceable++;
      stats.steps += outcome.steps;
      stats.impacts += outcome.impacts;
      stats.upgraded += outcome.upgraded;
      if (outcome.noArticle) stats.skippedNoArticle++;
    } catch (err) {
      // 하루 한도·예산 소진은 재시도해도 소용없다. 남은 이벤트를 헛돌리지 않고 멈춘다.
      if (err instanceof QuotaExceededError || err instanceof BudgetExceededError) {
        log.warn('한도 초과로 전파 경로 추적 중단', { err: err.message });
        break;
      }
      stats.failed++;
      log.error('전파 경로 추적 실패', { event_id: event.id, err: errorMessage(err) });
    }
  }

  log.info('전파 경로 추적 완료', { ...stats });
  return stats;
}

async function traceOne(
  supabase: ServiceClient,
  log: Logger,
  event: EventRow,
  autoPublish: boolean,
): Promise<{ traceable: boolean; steps: number; impacts: number; upgraded: number; noArticle: boolean }> {
  const articles = await loadArticles(supabase, event.id);
  if (articles.length === 0) {
    return { traceable: false, steps: 0, impacts: 0, upgraded: 0, noArticle: true };
  }

  // ── LLM 을 쓰기 전에 앵커부터 확인한다 ──────────────────────
  //
  // 아래 공개 게이트와 같은 조건이다. 그런데 그건 **호출을 다 하고 나서** 판정하므로,
  // 공개되지 못할 이벤트에도 LLM 이 이미 나간 뒤다. 무료 티어에서는 호출 수가 곧
  // 한도라 이 순서가 그대로 비용이 된다 (실측 2026-08-01: 하루 972회 중 238회가 429).
  if (!(await hasMentionAnchor(supabase, event.id))) {
    log.debug('기사에 상장사 이름이 없어 전파 경로를 그리지 않음', { event_id: event.id });
    await markTraced(supabase, event.id);
    return { traceable: false, steps: 0, impacts: 0, upgraded: 0, noArticle: false };
  }

  const result = await callLlm(
    supabase,
    { purpose: 'transmission', eventId: event.id },
    {
      schema: transmissionSchema,
      schemaName: 'transmission',
      system: TRANSMISSION_SYSTEM,
      user: buildTransmissionUser(
        { title: event.title, factualSummary: event.factual_summary },
        articles,
      ),
      tier: 'cheap',
      maxOutputTokens: 2500,
    },
  );
  const traced = result.data;

  const banned = scanObjectForBanned(traced);
  if (banned.length > 0) {
    throw new Error(`금지 표현 검출: ${banned.map((b) => `${b.path}=${b.phrase}`).join(', ')}`);
  }

  if (!traced.is_traceable || traced.steps.length === 0) {
    log.info('전파 경로를 그릴 수 없음', { event_id: event.id });
    await markTraced(supabase, event.id);
    return { traceable: false, steps: 0, impacts: 0, upgraded: 0, noArticle: false };
  }

  await persistSteps(supabase, event.id, traced.steps);

  // 이미 붙어 있는 종목의 방향은 정보다. uncertain 인 것만 덮어쓴다.
  const existing = await loadExistingImpacts(supabase, event.id);
  const judged = new Set(
    existing.filter((i) => i.impact_direction !== 'uncertain').map((i) => i.company_id),
  );
  const uncertain = new Set(
    existing.filter((i) => i.impact_direction === 'uncertain').map((i) => i.company_id),
  );

  const rows: ImpactRow[] = [];
  const seen = new Set<string>();

  // LLM 이 지목한 회사 이름을 실존 상장사로 해석한다. 사전에 없으면 버린다.
  const dict = await loadMentionDict(supabase);

  for (let i = 0; i < traced.steps.length; i++) {
    const step = traced.steps[i];
    const stepOrder = i + 1;

    // ── 1순위: LLM 이 사업 구조로 지목한 회사 ──────────────────
    // 문자열 매칭보다 이쪽이 먼저다. "이 회사가 왜 관련되는가" 를 말할 수 있는 건
    // 이쪽뿐이고, 그게 화면에서 유일하게 읽을 가치가 있는 정보다.
    const named = resolveCompanyNames(
      dict,
      (step.companies ?? []).map((c) => c.name),
    );
    if (named.unresolved.length > 0) {
      log.debug('상장사로 해석되지 않은 이름', {
        event_id: event.id,
        names: named.unresolved.join(', '),
      });
    }

    const reasonByName = new Map(
      (step.companies ?? []).map((c) => [c.name.trim(), c.reason]),
    );

    for (const hit of named.resolved) {
      if (judged.has(hit.company.companyId) || seen.has(hit.company.companyId)) continue;
      seen.add(hit.company.companyId);
      rows.push({
        companyId: hit.company.companyId,
        direction: step.direction,
        relationType: step.relation,
        relevanceScore: LLM_NAMED_SCORE,
        breakdown: llmBreakdown(),
        rationale: reasonByName.get(hit.proposedName) ?? step.reason,
        transmissionPath: [step.step],
        stepOrder,
        evidenceIds: [],
      });
    }

    // ── 2순위: 제품 문자열 매칭 (LLM 이 아무도 못 댔을 때만) ──
    //
    // **LLM 이 답한 단계에서는 아예 돌리지 않는다.** 둘을 섞으면 좋은 답이 노이즈에
    // 파묻힌다. 실측: 해상운임 급등 단계에서 LLM 은 HMM·팬오션·현대차를 댔는데,
    // 같은 단계의 문자열 매칭이 롯데하이마트(가전 소매)와 CJ ENM(방송)을 끌고 왔다.
    // "제품 문자열이 겹친다" 는 근거로는 그 둘을 구분할 방법이 없다.
    if (named.resolved.length > 0) continue;

    const candidates = await findCandidates(supabase, toQuery(step), log, {
      // 임베딩은 별도 한도를 쓰는데, 이 경로는 LLM 이 이미 구체적인 용어를 주므로
      // 정확·동의어·부분일치만으로 충분하다.
      useEmbedding: false,
    });
    if (candidates.length === 0) continue;

    const scored = candidates
      .map((candidate) => build(candidate, step, stepOrder, toQuery(step)))
      .filter((row): row is ImpactRow => row !== null)
      .sort((a, b) => b.relevanceScore - a.relevanceScore)
      .slice(0, MAX_IMPACTS_PER_STEP);

    for (const row of scored) {
      if (judged.has(row.companyId) || seen.has(row.companyId)) continue;
      seen.add(row.companyId);
      rows.push(row);
    }
  }

  const finalRows = rows
    .sort((a, b) => b.relevanceScore - a.relevanceScore)
    .slice(0, MAX_IMPACTS_PER_EVENT);

  const upgraded = finalRows.filter((r) => uncertain.has(r.companyId)).length;
  await persistImpacts(supabase, event.id, finalRows);
  await markTraced(supabase, event.id);

  // 앵커는 위에서 이미 확인했다(없으면 여기까지 오지 않는다).
  if (autoPublish && finalRows.length > 0 && event.status !== 'published') {
    await publish(supabase, event.id);
  }

  log.info('전파 경로 추적', {
    event_id: event.id,
    steps: traced.steps.length,
    impacts: finalRows.length,
    upgraded,
  });

  return {
    traceable: true,
    steps: traced.steps.length,
    impacts: finalRows.length,
    upgraded,
    noArticle: false,
  };
}

/**
 * LLM 지목 종목의 점수 내역.
 *
 * 문자열 매칭 항목(제품·집중도·공시)은 전부 0 이다 — 그런 근거로 뽑은 것이 아니다.
 * 화면의 점수 툴팁이 "이 종목은 왜 이 점수인가" 를 정직하게 보여줘야 하므로,
 * 없는 근거를 채워 넣지 않는다.
 */
function llmBreakdown(): ScoreBreakdown {
  return {
    product: 0,
    revenue: 0,
    geography: 0,
    supplyChain: 0,
    disclosure: 0,
    recency: 0,
    thematic: 0,
    llm: LLM_NAMED_SCORE,
    total: LLM_NAMED_SCORE,
    // 이유(reason)는 rationale 로 이미 화면에 나간다. 여기 또 넣으면 같은 문장이 두 번 보인다.
    notes: ['AI 가 사업 구조로 지목 · 실존 상장사로 확인됨'],
  };
}

/* ── 단계 → 종목 ──────────────────────────────────────── */

type ImpactRow = {
  companyId: string;
  direction: ImpactDirection;
  relationType: RelationType;
  relevanceScore: number;
  breakdown: ReturnType<typeof scoreCandidate>;
  rationale: string;
  transmissionPath: string[];
  /** 어느 단계에서 걸렸는가. 화면이 밸류체인 레인을 그리는 근거다 (0009) */
  stepOrder: number;
  evidenceIds: string[];
};

/**
 * LLM 이 준 용어를 검색 조건으로 바꾼다.
 *
 * affected_terms 를 products 에 넣는 이유는 KRX 주요제품이 유일하게 전 종목을
 * 덮는 데이터이기 때문이다. industries 는 별도로 받아 업종 매칭에 쓴다.
 */
function toQuery(step: TransmissionStep): EventQuery {
  return {
    industries: step.industry_terms,
    products: step.affected_terms,
    rawMaterials: [],
    customerGroups: [],
    geography: [],
  };
}

function build(
  candidate: Candidate,
  step: TransmissionStep,
  stepOrder: number,
  query: EventQuery,
): ImpactRow | null {
  const breakdown = scoreCandidate(candidate, query);
  const evidenceIds = Array.from(
    new Set(candidate.exposures.map((e) => e.evidenceId).filter((id): id is string => id !== null)),
  );

  // 점수·하드룰은 다른 경로와 **같은 함수**를 쓴다. 한 화면에 섞였을 때
  // 기준이 다르면 종목 간 비교가 불가능해진다.
  const ruled = applyHardRules(candidate, breakdown, step.relation, evidenceIds.length);
  if (ruled.excluded) return null;

  return {
    companyId: candidate.companyId,
    direction: step.direction,
    relationType: ruled.relationType,
    relevanceScore: ruled.score,
    breakdown,
    rationale: `${step.reason} (전파 ${stepOrder}단계: ${step.step})`,
    transmissionPath: [step.step],
    stepOrder,
    evidenceIds,
  };
}

/* ── 조회 ─────────────────────────────────────────────── */

async function loadEvents(
  supabase: ServiceClient,
  options: { limit?: number; eventIds?: string[] },
): Promise<EventRow[]> {
  let query = supabase
    .from('events')
    .select('id, title, factual_summary, status')
    .in('status', TARGET_STATUSES)
    .is('traced_at', null)
    .order('event_occurred_at', { ascending: false });

  if (options.eventIds?.length) query = query.in('id', options.eventIds);
  query = query.limit(options.limit ?? 3);

  const { data, error } = await query;
  if (error) throw new Error(`이벤트 조회 실패: ${error.message}`);
  return (data ?? []) as EventRow[];
}

async function loadArticles(supabase: ServiceClient, eventId: string): Promise<ArticleForPrompt[]> {
  const { data, error } = await supabase
    .from('event_articles')
    .select('news_articles(title, description, source_name, published_at)')
    .eq('event_id', eventId)
    .limit(10);
  if (error) throw new Error(`기사 조회 실패: ${error.message}`);

  type Joined = { news_articles: ArticleForPrompt | ArticleForPrompt[] | null };
  return ((data ?? []) as unknown as Joined[])
    .map((row) => (Array.isArray(row.news_articles) ? row.news_articles[0] : row.news_articles))
    .filter((a): a is ArticleForPrompt => Boolean(a));
}

async function loadExistingImpacts(
  supabase: ServiceClient,
  eventId: string,
): Promise<ExistingImpact[]> {
  const { data, error } = await supabase
    .from('event_impacts')
    .select('company_id, impact_direction')
    .eq('event_id', eventId);
  if (error) throw new Error(`기존 영향 조회 실패: ${error.message}`);
  return (data ?? []) as ExistingImpact[];
}

/* ── 저장 ─────────────────────────────────────────────── */

async function persistSteps(
  supabase: ServiceClient,
  eventId: string,
  steps: TransmissionStep[],
): Promise<void> {
  // 재추적 시 이전 결과가 섞이지 않도록 지우고 다시 넣는다.
  await supabase.from('event_transmission_steps').delete().eq('event_id', eventId);
  const { error } = await supabase.from('event_transmission_steps').insert(
    steps.map((step, index) => ({
      event_id: eventId,
      step_order: index + 1,
      description: step.step,
      // LLM 은 단계마다 방향·관계·근거를 이미 주고 있었다. 0009 이전에는
      // description 만 저장하고 나머지를 버려서, 화면이 "이 단계가 수혜인지
      // 피해인지"를 말할 수 없었다.
      direction: step.direction,
      relation: step.relation,
      reason: step.reason,
      chain_position: chainPosition(index + 1, steps.length),
    })),
  );
  if (error) throw new Error(`전파 단계 저장 실패: ${error.message}`);
}

/**
 * 밸류체인상 위치를 단계 순서에서 도출한다.
 *
 * LLM 에게 직접 물어보지 않는 이유: 산업마다 밸류체인 축이 달라서
 * (반도체의 "소재"와 조선의 "소재"는 층위가 다르다) 고정 축을 강요하면
 * 억지 매핑이 된다. 전파 경로는 이미 사건에서 멀어지는 순서로 생성되므로
 * 그 순서 자체가 상류→하류다.
 *
 * 단계가 하나뿐이면 상·하류를 말할 근거가 없으므로 midstream 으로 둔다.
 */
function chainPosition(stepOrder: number, total: number): 'upstream' | 'midstream' | 'downstream' {
  if (total === 1) return 'midstream';
  if (stepOrder === 1) return 'upstream';
  if (stepOrder === total) return 'downstream';
  return 'midstream';
}

async function persistImpacts(
  supabase: ServiceClient,
  eventId: string,
  rows: ImpactRow[],
): Promise<void> {
  if (rows.length === 0) return;

  const { data, error } = await supabase
    .from('event_impacts')
    .upsert(
      rows.map((row) => ({
        event_id: eventId,
        company_id: row.companyId,
        impact_direction: row.direction,
        impact_level: 'low' as const,
        relation_type: row.relationType,
        relevance_score: row.relevanceScore,
        score_breakdown: row.breakdown,
        confidence_score: null,
        rationale: row.rationale,
        transmission_path: row.transmissionPath,
        step_order: row.stepOrder,
        missing_evidence: ['실적 반영 규모는 확인되지 않았습니다.'],
        review_status: 'pending' as const,
        is_manual: false,
      })),
      { onConflict: 'event_id,company_id' },
    )
    .select('id, company_id');

  if (error) throw new Error(`영향 종목 저장 실패: ${error.message}`);

  const idByCompany = new Map((data ?? []).map((r) => [r.company_id, r.id]));
  const links = rows.flatMap((row) => {
    const impactId = idByCompany.get(row.companyId);
    if (!impactId) return [];
    return row.evidenceIds.map((evidenceId) => ({ impact_id: impactId, evidence_id: evidenceId }));
  });
  if (links.length > 0) {
    await supabase
      .from('event_impact_evidence')
      .upsert(links, { onConflict: 'impact_id,evidence_id', ignoreDuplicates: true });
  }
}

/** 같은 이벤트를 매번 다시 호출하지 않도록 표시한다. LLM 호출이 곧 한도다. */
async function markTraced(supabase: ServiceClient, eventId: string): Promise<void> {
  const { error } = await supabase
    .from('events')
    .update({ traced_at: new Date().toISOString() })
    .eq('id', eventId);
  if (error) throw new Error(`추적 표시 실패: ${error.message}`);
}

async function publish(supabase: ServiceClient, eventId: string): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await supabase
    .from('events')
    .update({ status: 'published', published_at: now, approved_at: now, reviewed_at: now })
    .eq('id', eventId);
  if (error) throw new Error(`자동 공개 실패: ${error.message}`);
}
