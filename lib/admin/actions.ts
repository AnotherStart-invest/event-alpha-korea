'use server';

import { revalidatePath } from 'next/cache';
import { createServerSupabase, requireAdmin } from '@/lib/db/server';
import { createServiceClient } from '@/lib/db/service';
import { publishTimestamps, assertTransition } from '@/lib/events/state';
import { findBannedPhrases } from '@/lib/shared/banned-words';
import { errorMessage } from '@/lib/shared/errors';
import type { EventStatus, ImpactDirection, RelationType } from '@/lib/db/enums';
import type { Json } from '@/lib/db/types';

/**
 * 관리자 서버 액션.
 *
 * ★ 모든 액션은 requireAdmin() 으로 시작한다. proxy.ts 의 검사만 믿지 않는다.
 * ★ 모든 변경은 admin_reviews 에 diff 와 함께 남긴다.
 */

export type ActionResult = { ok: true } | { ok: false; error: string };

async function audit(
  reviewer: string,
  targetType: 'event' | 'impact' | 'company' | 'exposure',
  targetId: string,
  action: string,
  diff?: Json,
  comment?: string,
) {
  const supabase = createServiceClient();
  await supabase.from('admin_reviews').insert({
    target_type: targetType,
    target_id: targetId,
    reviewer,
    action,
    diff: diff ?? null,
    comment: comment ?? null,
  });
}

async function currentStatus(eventId: string): Promise<EventStatus | null> {
  const supabase = createServiceClient();
  const { data } = await supabase.from('events').select('status').eq('id', eventId).maybeSingle();
  return (data?.status as EventStatus) ?? null;
}

export async function approveEvent(eventId: string): Promise<ActionResult> {
  try {
    const admin = await requireAdmin();
    const status = await currentStatus(eventId);
    if (!status) return { ok: false, error: '이벤트를 찾을 수 없습니다.' };
    assertTransition(status, 'published');

    const supabase = createServiceClient();
    const { error } = await supabase.from('events').update(publishTimestamps()).eq('id', eventId);
    if (error) return { ok: false, error: error.message };

    await supabase
      .from('event_impacts')
      .update({ review_status: 'approved' })
      .eq('event_id', eventId)
      .eq('review_status', 'pending');

    await audit(admin.id, 'event', eventId, 'approve', { from: status, to: 'published' });
    revalidatePath('/admin/events');
    revalidatePath(`/events/${eventId}`);
    revalidatePath('/');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export async function rejectEvent(eventId: string, comment: string): Promise<ActionResult> {
  try {
    const admin = await requireAdmin();
    const status = await currentStatus(eventId);
    if (!status) return { ok: false, error: '이벤트를 찾을 수 없습니다.' };
    assertTransition(status, 'rejected');

    const supabase = createServiceClient();
    const { error } = await supabase
      .from('events')
      .update({ status: 'rejected', reviewed_at: new Date().toISOString() })
      .eq('id', eventId);
    if (error) return { ok: false, error: error.message };

    await audit(admin.id, 'event', eventId, 'reject', { from: status, to: 'rejected' }, comment);
    revalidatePath('/admin/events');
    revalidatePath('/');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export async function unpublishEvent(eventId: string, comment: string): Promise<ActionResult> {
  try {
    const admin = await requireAdmin();
    const status = await currentStatus(eventId);
    if (!status) return { ok: false, error: '이벤트를 찾을 수 없습니다.' };
    assertTransition(status, 'pending_review');

    const supabase = createServiceClient();
    const { error } = await supabase
      .from('events')
      .update({ status: 'pending_review', published_at: null })
      .eq('id', eventId);
    if (error) return { ok: false, error: error.message };

    await audit(admin.id, 'event', eventId, 'unpublish', { from: status }, comment);
    revalidatePath('/admin/events');
    revalidatePath(`/events/${eventId}`);
    revalidatePath('/');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export async function updateEventSummary(
  eventId: string,
  fields: { title?: string; factual_summary?: string },
): Promise<ActionResult> {
  try {
    const admin = await requireAdmin();

    // 관리자 입력도 금지 표현 검사를 거친다 (I6)
    const banned = [
      ...findBannedPhrases(fields.title),
      ...findBannedPhrases(fields.factual_summary),
    ];
    if (banned.length > 0) {
      return { ok: false, error: `금지 표현이 포함되어 있습니다: ${banned.map((b) => b.phrase).join(', ')}` };
    }

    const supabase = createServiceClient();
    const { data: before } = await supabase
      .from('events')
      .select('title, factual_summary')
      .eq('id', eventId)
      .maybeSingle();

    const { error } = await supabase.from('events').update(fields).eq('id', eventId);
    if (error) return { ok: false, error: error.message };

    await audit(admin.id, 'event', eventId, 'edit', { before: before as Json, after: fields as Json });
    revalidatePath(`/admin/events/${eventId}`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export async function updateImpact(
  impactId: string,
  fields: {
    impact_direction?: ImpactDirection;
    relation_type?: RelationType;
    relevance_score?: number;
  },
): Promise<ActionResult> {
  try {
    const admin = await requireAdmin();
    if (fields.relevance_score !== undefined) {
      if (!Number.isInteger(fields.relevance_score) || fields.relevance_score < 0 || fields.relevance_score > 100) {
        return { ok: false, error: '관련도 점수는 0~100 사이의 정수여야 합니다.' };
      }
    }

    const supabase = createServiceClient();
    const { data: before } = await supabase
      .from('event_impacts')
      .select('event_id, impact_direction, relation_type, relevance_score')
      .eq('id', impactId)
      .maybeSingle();
    if (!before) return { ok: false, error: '종목 연결을 찾을 수 없습니다.' };

    const { error } = await supabase
      .from('event_impacts')
      .update({ ...fields, review_status: 'edited' })
      .eq('id', impactId);
    if (error) return { ok: false, error: error.message };

    await audit(admin.id, 'impact', impactId, 'edit', { before: before as Json, after: fields as Json });
    revalidatePath(`/admin/events/${before.event_id}`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export async function removeImpact(impactId: string): Promise<ActionResult> {
  try {
    const admin = await requireAdmin();
    const supabase = createServiceClient();

    const { data: before } = await supabase
      .from('event_impacts')
      .select('event_id, company_id')
      .eq('id', impactId)
      .maybeSingle();

    const { error } = await supabase.from('event_impacts').delete().eq('id', impactId);
    if (error) return { ok: false, error: error.message };

    await audit(admin.id, 'impact', impactId, 'remove_impact', before as Json);
    if (before) revalidatePath(`/admin/events/${before.event_id}`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

/** 관리자가 직접 종목을 추가한다. 종목코드로만 찾으므로 존재하지 않는 종목은 추가되지 않는다 (I1). */
export async function addImpact(
  eventId: string,
  stockCode: string,
  direction: ImpactDirection,
  rationale: string,
): Promise<ActionResult> {
  try {
    const admin = await requireAdmin();

    const banned = findBannedPhrases(rationale);
    if (banned.length > 0) {
      return { ok: false, error: `금지 표현이 포함되어 있습니다: ${banned.map((b) => b.phrase).join(', ')}` };
    }

    const supabase = createServiceClient();
    const { data: company } = await supabase
      .from('companies')
      .select('id, company_name')
      .eq('stock_code', stockCode.trim())
      .maybeSingle();

    if (!company) {
      return { ok: false, error: `종목코드 ${stockCode} 인 상장사를 찾을 수 없습니다.` };
    }

    const { error } = await supabase.from('event_impacts').upsert(
      {
        event_id: eventId,
        company_id: company.id,
        impact_direction: direction,
        impact_level: 'medium',
        relation_type: 'direct',
        relevance_score: 60,
        rationale,
        review_status: 'approved',
        is_manual: true,
      },
      { onConflict: 'event_id,company_id' },
    );
    if (error) return { ok: false, error: error.message };

    await audit(admin.id, 'event', eventId, 'add_impact', {
      stock_code: stockCode,
      company: company.company_name,
    });
    revalidatePath(`/admin/events/${eventId}`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

/** 이벤트를 분석 큐로 되돌린다. */
export async function reanalyzeEvent(eventId: string): Promise<ActionResult> {
  try {
    const admin = await requireAdmin();
    const status = await currentStatus(eventId);
    if (!status) return { ok: false, error: '이벤트를 찾을 수 없습니다.' };

    const supabase = createServiceClient();
    const { error } = await supabase
      .from('events')
      .update({ status: 'candidate', retry_count: 0, last_error: null })
      .eq('id', eventId);
    if (error) return { ok: false, error: error.message };

    await audit(admin.id, 'event', eventId, 'reanalyze', { from: status });
    revalidatePath(`/admin/events/${eventId}`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

/** 파이프라인 수동 실행. cron 라우트를 내부에서 호출한다. */
export async function runPipeline(job: 'collect' | 'cluster' | 'analyze'): Promise<ActionResult> {
  try {
    await requireAdmin();

    const { createServiceClient: service } = await import('@/lib/db/service');
    const supabase = service();
    const { runJob } = await import('@/lib/pipeline/run');

    if (job === 'collect') {
      const { collectNews } = await import('@/lib/news/collect');
      await runJob(supabase, 'collect', ({ log }) => collectNews(supabase, log));
    } else if (job === 'cluster') {
      const { clusterPendingArticles } = await import('@/lib/news/cluster-job');
      await runJob(supabase, 'cluster', ({ log }) => clusterPendingArticles(supabase, log));
    } else {
      const { analyzePendingEvents } = await import('@/lib/events/analyze');
      await runJob(supabase, 'analyze', ({ log }) => analyzePendingEvents(supabase, log));
    }

    revalidatePath('/admin');
    revalidatePath('/admin/events');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export async function signOut(): Promise<void> {
  const supabase = await createServerSupabase();
  await supabase.auth.signOut();
  revalidatePath('/admin');
}
