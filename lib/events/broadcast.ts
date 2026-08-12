import 'server-only';
import type { ServiceClient } from '@/lib/db/service';
import type { Logger } from '@/lib/shared/logger';
import type { EventRequirementRow, ScoreBreakdown } from '@/lib/db/types';
import { errorMessage } from '@/lib/shared/errors';
import { findBannedPhrases } from '@/lib/shared/banned-words';
import { formatBroadcast, type BroadcastCompany } from '@/lib/telegram/format';
import { isTelegramConfigured, sendMessage } from '@/lib/telegram/send';

/**
 * 공개된 이벤트를 텔레그램 채널에 올린다.
 *
 * **채널은 사이트보다 정정이 어렵다.** 한 번 나간 글은 회수가 안 되고, 구독자는
 * 틀린 글 하나로 채널 전체를 버린다. 그래서 여기 게이트는 화면보다 빡빡하다:
 *
 *   1. 분류가 붙어 있을 것 (event_type) — "분류 전" 을 채널에 뿌릴 이유가 없다
 *   2. 믿을 만한 근거의 종목이 하나라도 있을 것 (원문 직접 언급 · AI 사업구조 판단)
 *      키워드 문자열 매칭은 제외한다. 실측으로 그게 77% 였고, 그대로 뿌리면
 *      TSMC 기사에 롯데하이마트를 올리는 꼴이 된다
 *   3. 금지 표현이 없을 것 (매수·목표가 등)
 *
 * 실측(2026-08-12) 기준 이 게이트를 통과하는 공개 이벤트는 163건 중 7건이다.
 * 적다고 게이트를 낮추면 안 된다 — 콘텐츠가 부족한 것이지 기준이 높은 게 아니다.
 */

export type BroadcastStats = {
  candidates: number;
  sent: number;
  skippedNoClass: number;
  skippedNoCompany: number;
  skippedBanned: number;
  failed: number;
};

/** 한 번에 보낼 수 있는 글 수. 채널을 도배하면 바로 이탈한다. */
export const MAX_PER_RUN = 2;

type EventRow = {
  id: string;
  title: string;
  event_type: string | null;
  primary_variable: string | null;
  variable_direction: string;
  time_horizon: string;
};

export async function broadcastEvents(
  supabase: ServiceClient,
  log: Logger,
  options: { limit?: number; dryRun?: boolean } = {},
): Promise<BroadcastStats & { preview?: string[] }> {
  const stats: BroadcastStats = {
    candidates: 0,
    sent: 0,
    skippedNoClass: 0,
    skippedNoCompany: 0,
    skippedBanned: 0,
    failed: 0,
  };
  const preview: string[] = [];

  if (!options.dryRun && !isTelegramConfigured()) {
    log.info('텔레그램이 설정되지 않아 발송하지 않음');
    return { ...stats, preview };
  }

  const siteUrl = (process.env.APP_URL ?? 'https://eventalpha.org').replace(/\/$/, '');
  const limit = options.limit ?? MAX_PER_RUN;

  // 오래된 뉴스를 뒤늦게 올리면 채널의 신뢰가 떨어진다. 최신순으로 본다.
  const { data: events, error } = await supabase
    .from('events')
    .select('id, title, event_type, primary_variable, variable_direction, time_horizon')
    .eq('status', 'published')
    .is('broadcast_at', null)
    .not('event_type', 'is', null)
    .order('published_at', { ascending: false })
    .limit(limit * 5); // 게이트에서 떨어질 것을 감안해 넉넉히 뽑는다

  if (error) throw new Error(`발송 대상 조회 실패: ${error.message}`);

  for (const event of (events ?? []) as EventRow[]) {
    if (stats.sent >= limit) break;
    stats.candidates++;

    try {
      const companies = await loadTrustedCompanies(supabase, event.id);
      if (companies.length === 0) {
        stats.skippedNoCompany++;
        await markBroadcast(supabase, event.id); // 다시 후보로 올라오지 않게 표시
        continue;
      }

      const [steps, requirements] = await Promise.all([
        loadSteps(supabase, event.id),
        loadRequirements(supabase, event.id),
      ]);

      const text = formatBroadcast({
        event: event as never,
        steps,
        requirements,
        companies,
        siteUrl,
      });

      // 금지 표현은 화면보다 채널에서 더 위험하다. 마지막으로 한 번 더 본다.
      const banned = findBannedPhrases(text).map((b) => b.phrase);
      if (banned.length > 0) {
        stats.skippedBanned++;
        log.warn('금지 표현이 있어 발송하지 않음', { event_id: event.id, banned: banned.join(',') });
        await markBroadcast(supabase, event.id);
        continue;
      }

      if (options.dryRun) {
        preview.push(text);
        stats.sent++;
        continue;
      }

      await sendMessage(text);
      await markBroadcast(supabase, event.id);
      stats.sent++;
      log.info('채널 게시', { event_id: event.id, title: event.title.slice(0, 40) });
    } catch (err) {
      stats.failed++;
      // 발송 실패는 broadcast_at 을 남기지 않는다 — 다음 tick 에 다시 시도해야 한다.
      log.error('채널 게시 실패', { event_id: event.id, err: errorMessage(err) });
    }
  }

  log.info('채널 게시 완료', { ...stats });
  return { ...stats, preview };
}

/**
 * 채널에 실을 만한 종목만 고른다.
 *
 * 원문 직접 언급(mention)과 AI 사업구조 판단(llm)만 쓴다.
 * 키워드 문자열 매칭·동종 확장은 "왜 이 회사인가" 를 말하지 못하므로 채널에 못 올린다.
 */
async function loadTrustedCompanies(
  supabase: ServiceClient,
  eventId: string,
): Promise<BroadcastCompany[]> {
  const { data, error } = await supabase
    .from('event_impacts')
    .select('impact_direction, relevance_score, rationale, score_breakdown, companies(company_name, stock_code)')
    .eq('event_id', eventId)
    .order('relevance_score', { ascending: false });

  if (error) throw new Error(`종목 조회 실패: ${error.message}`);

  type Joined = {
    impact_direction: BroadcastCompany['direction'];
    rationale: string | null;
    score_breakdown: ScoreBreakdown | null;
    companies: { company_name: string; stock_code: string | null } | null;
  };

  return ((data ?? []) as unknown as Joined[])
    .filter((row) => {
      const b = row.score_breakdown;
      return typeof b?.mention === 'number' || typeof b?.llm === 'number';
    })
    .filter((row) => Boolean(row.companies))
    .map((row) => ({
      name: row.companies!.company_name,
      stockCode: row.companies!.stock_code,
      reason: row.rationale,
      direction: row.impact_direction,
    }));
}

async function loadSteps(supabase: ServiceClient, eventId: string) {
  const { data } = await supabase
    .from('event_transmission_steps')
    .select('step_order, description')
    .eq('event_id', eventId)
    .order('step_order');
  return data ?? [];
}

async function loadRequirements(supabase: ServiceClient, eventId: string) {
  const { data } = await supabase
    .from('event_requirements')
    .select('requirement_type, description')
    .eq('event_id', eventId)
    .order('sort_order');
  return (data ?? []) as Array<Pick<EventRequirementRow, 'requirement_type' | 'description'>>;
}

async function markBroadcast(supabase: ServiceClient, eventId: string): Promise<void> {
  const { error } = await supabase
    .from('events')
    .update({ broadcast_at: new Date().toISOString() })
    .eq('id', eventId);
  if (error) throw new Error(`발송 표시 실패: ${error.message}`);
}
