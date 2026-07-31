import { createServiceClient } from '@/lib/db/service';
import { clusterPendingArticles } from '@/lib/news/cluster-job';
import { cronResponse, runJob } from '@/lib/pipeline/run';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** 미처리 기사를 이벤트 후보로 묶는다. */
function handle(request: Request) {
  return cronResponse(request, async () => {
    const limitParam = new URL(request.url).searchParams.get('limit');
    const limit = limitParam ? Number(limitParam) : undefined;

    const supabase = createServiceClient();
    return runJob(supabase, 'cluster', ({ log }) =>
      clusterPendingArticles(supabase, log, {
        limit: Number.isFinite(limit) ? limit : undefined,
      }),
    );
  });
}

export const GET = handle;
export const POST = handle;
