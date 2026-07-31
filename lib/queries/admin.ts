import 'server-only';
import { createServiceClient } from '@/lib/db/service';
import type { EventStatus } from '@/lib/db/enums';

export type PipelineHealth = {
  job: string;
  lastRunAt: string | null;
  lastOk: boolean | null;
  minutesAgo: number | null;
  stats: unknown;
  error: string | null;
};

export type AdminDashboard = {
  counts: Record<EventStatus, number>;
  pendingArticles: number;
  companies: { total: number; withProfile: number };
  costToday: number;
  budget: number;
  pipelines: PipelineHealth[];
};

/** 파이프라인이 조용히 죽는 것이 가장 위험하다 (RISK §7). 마지막 성공 시각을 항상 보여준다. */
export async function getDashboard(): Promise<AdminDashboard> {
  const supabase = createServiceClient();

  const [events, articles, companies, exposures, cost, settings, runs] = await Promise.all([
    supabase.from('events').select('status'),
    supabase.from('news_articles').select('id', { count: 'exact', head: true }).eq('processing_status', 'pending'),
    supabase.from('companies').select('id', { count: 'exact', head: true }).not('stock_code', 'is', null),
    supabase.from('companies').select('id', { count: 'exact', head: true }).eq('verification_status', 'auto'),
    supabase.from('v_llm_cost_today').select('cost_usd').maybeSingle(),
    supabase.from('app_settings').select('daily_llm_budget_usd').eq('id', 1).maybeSingle(),
    supabase.from('pipeline_runs').select('job_name, started_at, ok, stats, error').order('started_at', { ascending: false }).limit(60),
  ]);

  const counts = {
    candidate: 0,
    analyzing: 0,
    analyzed: 0,
    pending_review: 0,
    published: 0,
    rejected: 0,
    failed: 0,
  } as Record<EventStatus, number>;

  for (const row of events.data ?? []) {
    counts[row.status as EventStatus] = (counts[row.status as EventStatus] ?? 0) + 1;
  }

  const seen = new Set<string>();
  const pipelines: PipelineHealth[] = [];
  for (const run of runs.data ?? []) {
    if (seen.has(run.job_name)) continue;
    seen.add(run.job_name);
    pipelines.push({
      job: run.job_name,
      lastRunAt: run.started_at,
      lastOk: run.ok,
      minutesAgo: run.started_at
        ? Math.floor((Date.now() - new Date(run.started_at).getTime()) / 60000)
        : null,
      stats: run.stats,
      error: run.error,
    });
  }
  for (const job of ['collect', 'cluster', 'analyze']) {
    if (!seen.has(job)) {
      pipelines.push({ job, lastRunAt: null, lastOk: null, minutesAgo: null, stats: null, error: null });
    }
  }

  return {
    counts,
    pendingArticles: articles.count ?? 0,
    companies: { total: companies.count ?? 0, withProfile: exposures.count ?? 0 },
    costToday: Number(cost.data?.cost_usd ?? 0),
    budget: Number(settings.data?.daily_llm_budget_usd ?? 3),
    pipelines,
  };
}

export type ReviewQueueItem = {
  id: string;
  title: string;
  status: EventStatus;
  event_occurred_at: string | null;
  event_confidence: number | null;
  last_error: string | null;
  impactCount: number;
  positiveCount: number;
  negativeCount: number;
};

export async function getReviewQueue(status?: EventStatus): Promise<ReviewQueueItem[]> {
  const supabase = createServiceClient();

  let query = supabase
    .from('events')
    .select('id, title, status, event_occurred_at, event_confidence, last_error, event_impacts(impact_direction)')
    .order('event_occurred_at', { ascending: false })
    .limit(80);

  if (status) query = query.eq('status', status);
  else query = query.in('status', ['pending_review', 'failed', 'candidate', 'published']);

  const { data, error } = await query;
  if (error) throw new Error(`검수 큐 조회 실패: ${error.message}`);

  type Joined = Omit<ReviewQueueItem, 'impactCount' | 'positiveCount' | 'negativeCount'> & {
    event_impacts: Array<{ impact_direction: string }> | null;
  };

  return ((data ?? []) as unknown as Joined[]).map((row) => {
    const impacts = row.event_impacts ?? [];
    return {
      ...row,
      impactCount: impacts.length,
      positiveCount: impacts.filter((i) => i.impact_direction === 'positive').length,
      negativeCount: impacts.filter((i) => i.impact_direction === 'negative').length,
    };
  });
}

export async function getAuditTrail(targetId: string) {
  const supabase = createServiceClient();
  const { data } = await supabase
    .from('admin_reviews')
    .select('id, action, comment, created_at, target_type')
    .eq('target_id', targetId)
    .order('created_at', { ascending: false })
    .limit(20);
  return data ?? [];
}
