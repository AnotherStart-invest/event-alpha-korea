import { createServiceClient } from '@/lib/db/service';
import { traceTransmission } from '@/lib/events/transmission';
import { cronResponse, runJob } from '@/lib/pipeline/run';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * 이벤트의 전파 경로를 그리고 그 경로에 걸리는 종목을 찾는다.
 *
 * mentions/peers 와 달리 LLM 을 쓴다(이벤트당 cheap 1회). 하루 한도가 곧 처리량이므로
 * limit 기본값이 작다. 한도가 소진되면 QuotaExceededError 로 배치가 즉시 멈춘다.
 */
function handle(request: Request) {
  return cronResponse(request, async () => {
    const params = new URL(request.url).searchParams;
    const limitParam = params.get('limit');
    const limit = limitParam ? Number(limitParam) : undefined;

    // 특정 이벤트만 다시 추적한다. 점수 체계를 고친 뒤 결과를 확인할 때 쓴다 —
    // 이게 없으면 "가장 최근 미추적 이벤트"만 잡혀서 원하는 이벤트를 겨냥할 수 없다.
    const eventIds = (params.get('eventIds') ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter((id) => UUID.test(id));

    const supabase = createServiceClient();
    return runJob(supabase, 'transmission', ({ log }) =>
      traceTransmission(supabase, log, {
        limit: Number.isFinite(limit) ? limit : undefined,
        eventIds: eventIds.length > 0 ? eventIds : undefined,
      }),
    );
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const GET = handle;
export const POST = handle;
