import 'server-only';
import type { ServiceClient } from '@/lib/db/service';
import type { Json } from '@/lib/db/types';
import { createLogger } from '@/lib/shared/logger';
import { errorMessage } from '@/lib/shared/errors';

/**
 * cron 작업 실행 래퍼.
 *
 * 두 겹의 중복 실행 방지:
 *  1) pipeline_runs(job_name, run_key) UNIQUE  — 같은 분(minute)의 재호출 차단
 *  2) 미완료 실행 확인                          — 동시 실행 차단
 *
 * 2번에 pg advisory lock 을 쓰지 않는 이유: PostgREST 는 커넥션 풀을 쓰므로
 * 세션 레벨 lock 을 잡은 커넥션과 푸는 커넥션이 다를 수 있다. 그러면 잠금이
 * 영원히 안 풀려 이후 모든 실행이 조용히 건너뛰어진다.
 *
 * 어느 쪽이든 걸리면 200 {skipped} 로 응답한다. cron 재시도 폭주를 막기 위해
 * 실패해도 5xx 를 던지지 않는 것이 이 래퍼의 계약이다.
 */

export type JobName = 'collect' | 'cluster' | 'analyze' | 'mentions' | 'peers' | 'transmission';

/** 이 시간이 지난 미완료 실행은 죽은 것으로 보고 회수한다. */
export const STALE_RUN_MINUTES = 10;

export type JobResult<T> =
  | { ok: true; skipped?: undefined; stats: T }
  | { ok: true; skipped: string; stats?: undefined }
  | { ok: false; error: string; stats?: Partial<T> };

/** 분 단위 실행 키. 같은 분에 두 번 호출되면 두 번째는 건너뛴다. */
export function minuteRunKey(job: JobName, now = new Date()): string {
  return `${job}:${now.toISOString().slice(0, 16)}`;
}

export async function runJob<T extends Record<string, unknown>>(
  supabase: ServiceClient,
  job: JobName,
  handler: (ctx: { log: ReturnType<typeof createLogger>; runId: string }) => Promise<T>,
  options: { runKey?: string } = {},
): Promise<JobResult<T>> {
  const log = createLogger(job);
  const runKey = options.runKey ?? minuteRunKey(job);

  // 1) 실행 기록 선점 — UNIQUE 위반이면 이미 이 분에 돌았다는 뜻
  const { data: run, error: insertError } = await supabase
    .from('pipeline_runs')
    .insert({ job_name: job, run_key: runKey })
    .select('id')
    .single();

  if (insertError || !run) {
    log.info('중복 실행 건너뜀', { run_key: runKey, reason: insertError?.code ?? 'no_row' });
    return { ok: true, skipped: `duplicate_run:${runKey}` };
  }

  // 2) 앞선 실행이 아직 돌고 있으면 건너뛴다.
  //    방금 만든 내 행은 finished_at 이 비어 있으므로 제외하고 확인한다.
  const { data: running } = await supabase
    .from('pipeline_runs')
    .select('id')
    .eq('job_name', job)
    .is('finished_at', null)
    .neq('id', run.id)
    .gte('started_at', new Date(Date.now() - STALE_RUN_MINUTES * 60_000).toISOString())
    .limit(1);

  if (running && running.length > 0) {
    log.info('앞선 실행이 진행 중, 건너뜀', { run_key: runKey });
    await supabase
      .from('pipeline_runs')
      .update({ finished_at: new Date().toISOString(), ok: true, error: 'already_running' })
      .eq('id', run.id);
    return { ok: true, skipped: 'already_running' };
  }

  try {
    const stats = await handler({ log, runId: run.id });
    await supabase
      .from('pipeline_runs')
      .update({ finished_at: new Date().toISOString(), ok: true, stats: stats as Json })
      .eq('id', run.id);
    log.info('완료', { run_key: runKey, ...toLogFields(stats) });
    return { ok: true, stats };
  } catch (err) {
    const message = errorMessage(err);
    log.error('실패', { run_key: runKey, err: message });
    await supabase
      .from('pipeline_runs')
      .update({ finished_at: new Date().toISOString(), ok: false, error: message })
      .eq('id', run.id);
    return { ok: false, error: message };
  }
  // 잠금 해제가 따로 필요 없다. finished_at 이 채워지는 것이 곧 해제다.
}

function toLogFields(stats: Record<string, unknown>) {
  const fields: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(stats)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      fields[key] = value;
    }
  }
  return fields;
}

/**
 * cron 라우트 공통 래퍼.
 *
 * 설정 오류(환경변수 누락 등)는 runJob 바깥에서 던져지므로 여기서 잡는다.
 * cron 엔드포인트가 5xx 를 반환하면 스케줄러가 재시도를 폭주시키므로,
 * 실패해도 200 + {ok:false} 로 응답하는 것이 이 래퍼의 계약이다.
 * (인증 실패만 예외적으로 401 을 준다)
 */
export async function cronResponse(
  request: Request,
  handler: () => Promise<unknown>,
): Promise<Response> {
  if (!isAuthorizedCron(request)) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }
  try {
    return Response.json(await handler());
  } catch (err) {
    const message = errorMessage(err);
    createLogger('cron').error('라우트 실패', { err: message });
    return Response.json({ ok: false, error: message });
  }
}

/** cron 엔드포인트 인증. CRON_SECRET 이 없으면 개발 환경에서만 통과시킨다. */
export function isAuthorizedCron(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return process.env.NODE_ENV !== 'production';

  const header = request.headers.get('authorization');
  if (header === `Bearer ${secret}`) return true;

  // Vercel Cron 은 x-vercel-cron 헤더를 붙인다
  return request.headers.get('x-vercel-cron') !== null && header === `Bearer ${secret}`;
}
