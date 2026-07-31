import { createServiceClient } from '@/lib/db/service';
import { linkPeerCompanies } from '@/lib/events/peers';
import { cronResponse, runJob } from '@/lib/pipeline/run';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * 이미 붙은 종목과 같은 제품군인 상장사를 추가로 붙인다.
 *
 * mentions 와 마찬가지로 LLM 을 부르지 않으므로 예산·한도와 무관하다.
 * 반드시 mentions/analyze 뒤에 돌아야 한다 — 씨앗이 없으면 아무것도 하지 않는다.
 */
function handle(request: Request) {
  return cronResponse(request, async () => {
    const limitParam = new URL(request.url).searchParams.get('limit');
    const limit = limitParam ? Number(limitParam) : undefined;

    const supabase = createServiceClient();
    return runJob(supabase, 'peers', ({ log }) =>
      linkPeerCompanies(supabase, log, {
        limit: Number.isFinite(limit) ? limit : undefined,
      }),
    );
  });
}

export const GET = handle;
export const POST = handle;
