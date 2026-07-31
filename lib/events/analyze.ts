import 'server-only';
import type { ServiceClient } from '@/lib/db/service';
import type { Logger } from '@/lib/shared/logger';
import { BudgetExceededError, QuotaExceededError, errorMessage } from '@/lib/shared/errors';
import { scanObjectForBanned } from '@/lib/shared/banned-words';
import { callLlm } from '@/lib/llm';
import {
  eventStructureSchema,
  hasSearchableKeywords,
  impactBatchSchema,
  prefilterSchema,
  type EventStructure,
} from '@/lib/llm/schemas';
import {
  EVENT_STRUCTURE_SYSTEM,
  IMPACT_SYSTEM,
  PREFILTER_SYSTEM,
  buildEventStructureUser,
  buildPrefilterUser,
  type ArticleForPrompt,
} from '@/lib/llm/prompts';
import { findCandidates, fetchEvidence } from '@/lib/matching/candidates';
import { buildImpactUser, chunkCandidates, deriveImpacts, validateImpacts } from '@/lib/matching/impacts';
import type { ModelTier } from '@/lib/llm/models';
import type { EventQuery } from '@/lib/matching/types';
import { MAX_RETRY, assertTransition } from './state';

export type AnalyzeStats = {
  processed: number;
  published: number; // pending_review 로 넘어간 수
  rejected: number;
  failed: number;
  impacts: number;
  droppedUnknownCompany: number;
};

type QueuedEvent = {
  id: string;
  title: string;
  status: 'candidate' | 'failed';
  retry_count: number;
};

type AnalyzeConfig = {
  /** 방향(긍정·부정)까지 LLM 으로 판정할 것인가. false 면 관련 종목만 확정한다. */
  judgeImpacts: boolean;
  /** 이벤트 구조화에 쓸 모델 티어. 무료 티어에서는 standard 가 하루 20회라 cheap 이 기본이다. */
  structureTier: ModelTier;
  /** MVP 자동 공개 */
  autoPublish: boolean;
};

export async function analyzePendingEvents(
  supabase: ServiceClient,
  log: Logger,
  options: { limit?: number } = {},
): Promise<AnalyzeStats> {
  const { data: settings } = await supabase
    .from('app_settings')
    .select('max_events_per_tick, analyze_enabled, judge_impacts, structure_tier, auto_publish')
    .eq('id', 1)
    .maybeSingle();

  if (settings?.analyze_enabled === false) {
    return { processed: 0, published: 0, rejected: 0, failed: 0, impacts: 0, droppedUnknownCompany: 0 };
  }

  const limit =
    options.limit ??
    (process.env.NODE_ENV === 'production' ? (settings?.max_events_per_tick ?? 3) : 1);

  const config: AnalyzeConfig = {
    // 방향 판정은 두 번째 LLM 호출이다. 끄면 이벤트당 호출이 절반이 되고
    // 무료 티어 하루 처리량이 두 배가 된다. 관련 종목 자체는 그대로 나온다.
    judgeImpacts: settings?.judge_impacts ?? false,
    structureTier: (settings?.structure_tier as ModelTier) ?? 'cheap',
    autoPublish: settings?.auto_publish ?? false,
  };

  const { data: queue, error } = await supabase
    .from('events')
    .select('id, title, status, retry_count')
    .in('status', ['candidate', 'failed'])
    .lt('retry_count', MAX_RETRY)
    .order('event_occurred_at', { ascending: true })
    .limit(limit);

  if (error) throw new Error(`분석 큐 조회 실패: ${error.message}`);

  const stats: AnalyzeStats = {
    processed: 0,
    published: 0,
    rejected: 0,
    failed: 0,
    impacts: 0,
    droppedUnknownCompany: 0,
  };

  for (const event of (queue ?? []) as QueuedEvent[]) {
    try {
      const outcome = await analyzeOne(supabase, log, event, config);
      stats.processed++;
      if (outcome.rejected) stats.rejected++;
      else stats.published++;
      stats.impacts += outcome.impacts;
      stats.droppedUnknownCompany += outcome.droppedUnknownCompany;
    } catch (err) {
      // 예산 초과와 하루 한도 소진은 재시도해도 소용없다. 큐를 되돌리고 즉시 중단한다.
      // 계속 돌면 남은 이벤트마다 똑같이 실패하면서 retry_count 만 태운다.
      if (err instanceof BudgetExceededError || err instanceof QuotaExceededError) {
        log.warn('한도 초과로 분석 중단', { err: err.message });
        await supabase
          .from('events')
          .update({ status: 'candidate', last_error: err.message })
          .eq('id', event.id);
        break;
      }
      stats.failed++;
      log.error('이벤트 분석 실패', { event_id: event.id, err: errorMessage(err) });
      await supabase
        .from('events')
        .update({
          status: 'failed',
          retry_count: event.retry_count + 1,
          last_error: errorMessage(err).slice(0, 500),
        })
        .eq('id', event.id);
    }
  }

  return stats;
}

async function analyzeOne(
  supabase: ServiceClient,
  log: Logger,
  event: QueuedEvent,
  config: AnalyzeConfig,
): Promise<{ rejected: boolean; impacts: number; droppedUnknownCompany: number }> {
  assertTransition(event.status, 'analyzing');
  await supabase.from('events').update({ status: 'analyzing' }).eq('id', event.id);

  const articles = await loadArticles(supabase, event.id);
  if (articles.length === 0) throw new Error('연결된 기사가 없습니다.');

  // ── S4. 사전필터 (저비용 모델) ──────────────────────────
  const prefilter = await callLlm(
    supabase,
    { purpose: 'prefilter', eventId: event.id },
    {
      schema: prefilterSchema,
      schemaName: 'prefilter',
      system: PREFILTER_SYSTEM,
      user: buildPrefilterUser(articles),
      tier: 'cheap',
      maxOutputTokens: 512,
    },
  );

  if (!prefilter.data.is_investment_relevant || prefilter.data.confidence < 50) {
    await supabase.from('events').update({ status: 'rejected', last_error: null }).eq('id', event.id);
    await supabase.from('admin_reviews').insert({
      target_type: 'event',
      target_id: event.id,
      action: 'auto_filtered',
      comment: prefilter.data.reason,
    });
    log.info('사전필터 탈락', { event_id: event.id, reason: prefilter.data.reason });
    return { rejected: true, impacts: 0, droppedUnknownCompany: 0 };
  }

  // ── S5. 이벤트 구조화 ──────────────────────────────────
  const structured = await callLlm(
    supabase,
    { purpose: 'event_structure', eventId: event.id },
    {
      schema: eventStructureSchema,
      schemaName: 'event_structure',
      system: EVENT_STRUCTURE_SYSTEM,
      user: buildEventStructureUser(articles),
      tier: config.structureTier,
      maxOutputTokens: 3000,
    },
  );
  const structure = structured.data;

  // V1 — 금지 표현
  const banned = scanObjectForBanned(structure);
  if (banned.length > 0) {
    throw new Error(`금지 표현 검출: ${banned.map((b) => `${b.path}=${b.phrase}`).join(', ')}`);
  }
  // V3 — 검색어가 없으면 종목을 찾을 방법이 없다
  if (!hasSearchableKeywords(structure)) {
    throw new Error('후보 검색에 쓸 키워드가 생성되지 않았습니다.');
  }
  if (!structure.is_investment_relevant) {
    await supabase.from('events').update({ status: 'rejected' }).eq('id', event.id);
    return { rejected: true, impacts: 0, droppedUnknownCompany: 0 };
  }

  await persistStructure(supabase, event.id, structure);

  // ── S6-1. 후보 생성 (LLM 미사용) ────────────────────────
  const query: EventQuery = {
    industries: structure.affected_industries,
    products: structure.affected_products,
    rawMaterials: structure.affected_raw_materials,
    customerGroups: structure.affected_customer_groups,
    geography: structure.geography,
  };
  const candidates = await findCandidates(supabase, query, log);

  if (candidates.length === 0) {
    log.warn('후보 종목 없음', { event_id: event.id });
    await finish(supabase, event.id, config, 0);
    return { rejected: false, impacts: 0, droppedUnknownCompany: 0 };
  }

  // ── S6-2a. 방향 판정 없이 확정 (LLM 미사용) ──────────────
  // 무료 티어 기본 경로다. "무엇과 겹치는가"까지만 말하고 방향은 남기지 않는다.
  if (!config.judgeImpacts) {
    const derived = deriveImpacts(candidates, query);
    await persistImpacts(supabase, event.id, derived.impacts);
    await finish(supabase, event.id, config, derived.impacts.length);
    log.info('관련 종목 확정 (방향 판정 없음)', {
      event_id: event.id,
      candidates: candidates.length,
      impacts: derived.impacts.length,
    });
    return { rejected: false, impacts: derived.impacts.length, droppedUnknownCompany: 0 };
  }

  // ── S6-2b. 영향 판정 (LLM, 입력은 후보로 제한) ───────────
  const evidenceIds = candidates.flatMap((c) =>
    c.exposures.map((e) => e.evidenceId).filter((id): id is string => id !== null),
  );
  const evidence = await fetchEvidence(supabase, evidenceIds);

  let totalImpacts = 0;
  let droppedUnknown = 0;

  for (const batch of chunkCandidates(candidates)) {
    const judgement = await callLlm(
      supabase,
      { purpose: 'impact', eventId: event.id },
      {
        schema: impactBatchSchema,
        schemaName: 'impact_batch',
        system: IMPACT_SYSTEM,
        user: buildImpactUser(
          {
            title: structure.event_title,
            factualSummary: structure.factual_summary,
            primaryVariable: structure.primary_variable,
            variableDirection: structure.variable_direction,
            geography: structure.geography,
            transmissionChain: structure.transmission_chain,
          },
          batch,
          evidence,
        ),
        tier: 'standard',
        maxOutputTokens: 8000,
      },
    );

    const validated = validateImpacts(judgement.data.impacts, batch, query);
    droppedUnknown += validated.stats.droppedUnknownCompany;

    if (validated.stats.droppedUnknownCompany > 0) {
      // 0 이 아니면 프롬프트나 후보 생성에 문제가 있다는 신호다.
      log.warn('후보 밖 기업이 출력됨', {
        event_id: event.id,
        dropped: validated.stats.droppedUnknownCompany,
      });
    }

    await persistImpacts(supabase, event.id, validated.impacts);
    totalImpacts += validated.impacts.length;
  }

  await finish(supabase, event.id, config, totalImpacts);

  log.info('이벤트 분석 완료', { event_id: event.id, impacts: totalImpacts });
  return { rejected: false, impacts: totalImpacts, droppedUnknownCompany: droppedUnknown };
}

/**
 * 분석을 끝낸 이벤트의 상태를 정한다.
 *
 * auto_publish 가 켜져 있고 종목이 하나라도 붙었으면 바로 공개한다.
 * published_requires_ts 제약 때문에 두 타임스탬프를 같이 채워야 한다.
 */
async function finish(
  supabase: ServiceClient,
  eventId: string,
  config: AnalyzeConfig,
  impactCount: number,
): Promise<void> {
  const publish = config.autoPublish && impactCount > 0;
  const now = new Date().toISOString();

  const { error } = await supabase
    .from('events')
    .update(
      publish
        ? { status: 'published', published_at: now, approved_at: now, reviewed_at: now, last_error: null }
        : { status: 'pending_review', last_error: null },
    )
    .eq('id', eventId);
  if (error) throw new Error(`이벤트 상태 갱신 실패: ${error.message}`);
}

/* ── 저장 ─────────────────────────────────────────────── */

async function loadArticles(supabase: ServiceClient, eventId: string): Promise<ArticleForPrompt[]> {
  const { data, error } = await supabase
    .from('event_articles')
    .select('article_id, news_articles(title, description, source_name, published_at)')
    .eq('event_id', eventId)
    .limit(10);

  if (error) throw new Error(`기사 조회 실패: ${error.message}`);

  type Joined = { news_articles: ArticleForPrompt | ArticleForPrompt[] | null };
  return ((data ?? []) as unknown as Joined[])
    .map((row) => (Array.isArray(row.news_articles) ? row.news_articles[0] : row.news_articles))
    .filter((a): a is ArticleForPrompt => Boolean(a));
}

async function persistStructure(
  supabase: ServiceClient,
  eventId: string,
  structure: EventStructure,
): Promise<void> {
  const { error } = await supabase
    .from('events')
    .update({
      title: structure.event_title,
      factual_summary: structure.factual_summary,
      event_type: structure.event_type,
      primary_variable: structure.primary_variable,
      variable_direction: structure.variable_direction,
      geography: structure.geography,
      time_horizon: structure.time_horizon,
      event_confidence: structure.event_confidence,
      novelty_score: structure.novelty_score,
      affected_industries: structure.affected_industries,
      affected_products: structure.affected_products,
      affected_raw_materials: structure.affected_raw_materials,
      affected_customer_groups: structure.affected_customer_groups,
    })
    .eq('id', eventId);
  if (error) throw new Error(`이벤트 저장 실패: ${error.message}`);

  // 재분석 시 이전 결과가 섞이지 않도록 지우고 다시 넣는다.
  await supabase.from('event_transmission_steps').delete().eq('event_id', eventId);
  await supabase.from('event_requirements').delete().eq('event_id', eventId);

  if (structure.transmission_chain.length > 0) {
    await supabase.from('event_transmission_steps').insert(
      structure.transmission_chain.map((description, index) => ({
        event_id: eventId,
        step_order: index + 1,
        description,
      })),
    );
  }

  const requirements = [
    ...structure.required_evidence.map((description, i) => ({
      event_id: eventId,
      requirement_type: 'evidence_to_check' as const,
      description,
      sort_order: i,
    })),
    ...structure.invalidation_conditions.map((description, i) => ({
      event_id: eventId,
      requirement_type: 'invalidation_condition' as const,
      description,
      sort_order: i,
    })),
    ...structure.follow_up_events.map((description, i) => ({
      event_id: eventId,
      requirement_type: 'follow_up_event' as const,
      description,
      sort_order: i,
    })),
  ];
  if (requirements.length > 0) {
    await supabase.from('event_requirements').insert(requirements);
  }
}

async function persistImpacts(
  supabase: ServiceClient,
  eventId: string,
  impacts: Awaited<ReturnType<typeof validateImpacts>>['impacts'],
): Promise<void> {
  if (impacts.length === 0) return;

  const { data, error } = await supabase
    .from('event_impacts')
    .upsert(
      impacts.map((impact) => ({
        event_id: eventId,
        company_id: impact.companyId,
        impact_direction: impact.impactDirection,
        impact_level: impact.impactLevel,
        relation_type: impact.relationType,
        relevance_score: impact.relevanceScore,
        score_breakdown: impact.breakdown,
        confidence_score: impact.confidenceScore,
        rationale: impact.rationale,
        transmission_path: impact.transmissionPath,
        missing_evidence: impact.missingEvidence,
        review_status: 'pending' as const,
        is_manual: false,
      })),
      { onConflict: 'event_id,company_id' },
    )
    .select('id, company_id');

  if (error) throw new Error(`영향 종목 저장 실패: ${error.message}`);

  const idByCompany = new Map((data ?? []).map((row) => [row.company_id, row.id]));
  const links = impacts.flatMap((impact) => {
    const impactId = idByCompany.get(impact.companyId);
    if (!impactId) return [];
    return impact.evidenceIds.map((evidenceId) => ({ impact_id: impactId, evidence_id: evidenceId }));
  });

  if (links.length > 0) {
    await supabase
      .from('event_impact_evidence')
      .upsert(links, { onConflict: 'impact_id,evidence_id', ignoreDuplicates: true });
  }
}
