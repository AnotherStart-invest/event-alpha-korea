import { createServiceClient } from '@/lib/db/service';
import { linkMentionedCompanies } from '@/lib/events/mentions';
import { cronResponse, runJob } from '@/lib/pipeline/run';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * 기사에 직접 이름이 나온 상장사를 이벤트에 붙인다.
 *
 * analyze 와 달리 LLM 을 부르지 않으므로 예산·한도와 무관하다.
 * 그래서 자주 돌려도 되고, 분석이 아직 안 된 이벤트에도 적용된다.
 */
function handle(request: Request) {
  return cronResponse(request, async () => {
    const limitParam = new URL(request.url).searchParams.get('limit');
    const limit = limitParam ? Number(limitParam) : undefined;

    const supabase = createServiceClient();
    return runJob(supabase, 'mentions', ({ log }) =>
      linkMentionedCompanies(supabase, log, {
        limit: Number.isFinite(limit) ? limit : undefined,
      }),
    );
  });
}

export const GET = handle;
export const POST = handle;
