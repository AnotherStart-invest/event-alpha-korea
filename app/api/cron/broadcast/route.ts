import { createServiceClient } from '@/lib/db/service';
import { broadcastEvents } from '@/lib/events/broadcast';
import { cronResponse, runJob } from '@/lib/pipeline/run';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * 공개된 이벤트를 텔레그램 채널에 올린다.
 *
 * LLM 을 쓰지 않는다. 화면에 이미 있는 것을 옮길 뿐이다.
 *
 * `?dryRun=1` 을 붙이면 **보내지 않고 본문만 돌려준다.** 채널을 켜기 전에
 * 무엇이 나갈지 눈으로 확인하는 용도다 — 한 번 나간 글은 회수가 안 된다.
 */
function handle(request: Request) {
  return cronResponse(request, async () => {
    const params = new URL(request.url).searchParams;
    const limitParam = params.get('limit');
    const limit = limitParam ? Number(limitParam) : undefined;
    const dryRun = params.get('dryRun') === '1';

    const supabase = createServiceClient();
    return runJob(supabase, 'broadcast', ({ log }) =>
      broadcastEvents(supabase, log, {
        limit: Number.isFinite(limit) ? limit : undefined,
        dryRun,
      }),
    );
  });
}

export const GET = handle;
export const POST = handle;
