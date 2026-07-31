import { createServiceClient } from '@/lib/db/service';
import { collectNews } from '@/lib/news/collect';
import { cronResponse, runJob } from '@/lib/pipeline/run';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * 뉴스 수집 tick.
 *
 * GET  /api/cron/collect   — cron 용 (Authorization: Bearer $CRON_SECRET)
 * POST /api/cron/collect   — 관리자 수동 실행 (같은 인증)
 *
 * 쿼리: ?keyword=관세 (단일 키워드), ?limit=3 (키워드 수)
 */
function handle(request: Request) {
  return cronResponse(request, async () => {
    const url = new URL(request.url);
    const keyword = url.searchParams.get('keyword') ?? undefined;
    const limitParam = url.searchParams.get('limit');
    const limit = limitParam ? Number(limitParam) : undefined;

    const supabase = createServiceClient();

    const { data: settings } = await supabase
      .from('app_settings')
      .select('collect_enabled')
      .eq('id', 1)
      .maybeSingle();

    if (settings && settings.collect_enabled === false) {
      return { ok: true, skipped: 'collect_disabled' };
    }

    return runJob(supabase, 'collect', ({ log }) =>
      collectNews(supabase, log, { keyword, limit: Number.isFinite(limit) ? limit : undefined }),
    );
  });
}

export const GET = handle;
export const POST = handle;
