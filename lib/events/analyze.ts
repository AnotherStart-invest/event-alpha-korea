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
import { hasMentionAnchor } from './anchor';

export type AnalyzeStats = {
  processed: number;
  published: number; // pending_review 로 넘어간 수
  /** 기사에 상장사 이름이 없어 LLM 을 쓰지 않고 걸러낸 수 */
  skippedNoAnchor: number;
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
    return {
      processed: 0,
      published: 0,
      rejected: 0,
      failed: 0,
      impacts: 0,
      droppedUnknownCompany: 0,
      skippedNoAnchor: 0,
    };
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
    // **최신순이다.** 오름차순(오래된 것부터)이었는데, 그게 "기사가 바로 분류되지
    // 않는" 원인이었다.
    //
    // 실측(2026-08-02): candidate 백로그 2,807건. tick 당 3건씩 처리하니 새로 들어온
    // 기사는 큐 맨 뒤에 서서 **3일**을 기다렸다. 게다가 mentions 는 최신 40건에만
    // 앵커를 붙이는데(내림차순) analyze 는 가장 오래된 것부터 봤다 —
    // **두 잡이 정반대 방향을 봐서 서로 만나지 못했다.** analyze 로그가 매번
    // `processed: 3, rejected: 3` 이었던 이유다: 앵커 없는 옛 이벤트만 계속 기각했다.
    //
    // 뉴스 서비스에서 오래된 사건을 먼저 처리할 이유가 없다. 방향을 맞춘다.
    .order('event_occurred_at', { ascending: false, nullsFirst: false })
    .limit(limit);

  if (error) throw new Error(`분석 큐 조회 실패: ${error.message}`);

  const stats: AnalyzeStats = {
    processed: 0,
    published: 0,
    rejected: 0,
    failed: 0,
    impacts: 0,
    droppedUnknownCompany: 0,
    skippedNoAnchor: 0,
  };

  for (const event of (queue ?? []) as QueuedEvent[]) {
    try {
      // ── LLM 을 쓰기 전에 앵커부터 확인한다 ────────────────────
      //
      // 기사에 상장사 이름이 없는 이벤트는 공개 게이트(anchor.ts)에서 어차피
      // 막힌다. 그런데 지금까지는 그 판정을 **공개 시점에만** 하고 호출 시점에는
      // 안 해서, 공개될 수 없는 이벤트에 LLM 을 쓰고 있었다.
      //
      // 실측(2026-08-01): 하루 972회 호출 중 238회가 429. 공개된 488건 중
      // 297건(61%)이 앵커가 없었다 — 그만큼이 통째로 낭비였다.
      // cron 순서가 mentions → analyze 라 이 시점엔 앵커 여부를 이미 알 수 있다.
      if (!(await hasMentionAnchor(supabase, event.id))) {
        await rejectWithoutAnchor(supabase, event.id);
        stats.processed++;
        stats.rejected++;
        stats.skippedNoAnchor++;
        continue;
      }

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
 * auto_publish 가 켜져 있고, 종목이 붙었고, **기사에 상장사 이름이 실제로 나왔을 때만**
 * 공개한다. 마지막 조건이 없으면 용어가 겹쳤다는 이유만으로 아무 기사나 공개된다.
 * published_requires_ts 제약 때문에 두 타임스탬프를 같이 채워야 한다.
 */
async function finish(
  supabase: ServiceClient,
  eventId: string,
  config: AnalyzeConfig,
  impactCount: number,
): Promise<void> {
  const publish =
    config.autoPublish && impactCount > 0 && (await hasMentionAnchor(supabase, eventId));
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

/**
 * 기사에 상장사 이름이 없어 분석 가치가 없는 이벤트를 큐에서 뺀다.
 *
 * **candidate 로 두면 안 된다.** 매 tick 마다 다시 뽑혀 limit 를 차지하고,
 * 정작 분석해야 할 새 이벤트가 밀린다. 상태를 확정해 큐에서 빼야 한다.
 */
async function rejectWithoutAnchor(supabase: ServiceClient, eventId: string): Promise<void> {
  const { error } = await supabase
    .from('events')
    .update({
      status: 'rejected',
      reviewed_at: new Date().toISOString(),
      last_error: '기사에 상장사 이름이 없어 분석하지 않음',
    })
    .eq('id', eventId);
  if (error) throw new Error(`앵커 없는 이벤트 정리 실패: ${error.message}`);
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
