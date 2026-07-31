import { createServiceClient } from '@/lib/db/service';
import { analyzePendingEvents } from '@/lib/events/analyze';
import { cronResponse, runJob } from '@/lib/pipeline/run';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** 이벤트 후보를 LLM 으로 구조화하고 관련 종목을 붙인다. */
function handle(request: Request) {
  return cronResponse(request, async () => {
    const limitParam = new URL(request.url).searchParams.get('limit');
    const limit = limitParam ? Number(limitParam) : undefined;

    const supabase = createServiceClient();
    return runJob(supabase, 'analyze', ({ log }) =>
      analyzePendingEvents(supabase, log, { limit: Number.isFinite(limit) ? limit : undefined }),
    );
  });
}

export const GET = handle;
export const POST = handle;
