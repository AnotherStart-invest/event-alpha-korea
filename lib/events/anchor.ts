import 'server-only';
import type { ServiceClient } from '@/lib/db/service';
import type { ScoreBreakdown } from '@/lib/db/types';

/**
 * 기사 앵커 — **이 이벤트의 기사에 상장사 이름이 실제로 나왔는가.**
 *
 * 제품 원칙: 기사 본문에 적시된 기업이 출발점이고, 밸류체인은 거기서 확장한다.
 * 그 반대가 되면 안 된다.
 *
 * 이 게이트가 없을 때 무슨 일이 일어났나 — 자동 공개 경로가 4개(analyze·mentions·
 * peers·transmission)인데 그중 mentions 만 기사에 앵커돼 있었다. 나머지 셋은
 * "LLM 이 만든 용어가 KRX 주요제품과 겹친다" 만으로 공개했고, 그래서
 * **고양이 당뇨 기사에 상장사가 붙어 공개되는** 일이 생겼다.
 *
 * 기사에 상장사 이름이 하나도 없으면 이 서비스가 할 말이 없다. 공개하지 않는다.
 */

/** 기사 직접 언급으로 붙은 impact 가 하나라도 있는가. */
export async function hasMentionAnchor(
  supabase: ServiceClient,
  eventId: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from('event_impacts')
    .select('score_breakdown')
    .eq('event_id', eventId);

  if (error) throw new Error(`앵커 확인 실패: ${error.message}`);
  return (data ?? []).some(
    (row) => typeof (row.score_breakdown as ScoreBreakdown)?.mention === 'number',
  );
}

/**
 * 기사에 언급된 상장사 목록. 밸류체인 확장의 **씨앗**이다.
 *
 * 여기서 나온 기업의 실제 제품·업종이 곧 "이 사건이 건드리는 것" 이므로,
 * 전·후방을 찾을 때 LLM 이 지어낸 용어보다 이쪽이 훨씬 믿을 만하다.
 */
export async function loadMentionAnchors(
  supabase: ServiceClient,
  eventId: string,
): Promise<Array<{ companyId: string; companyName: string; industryName: string | null }>> {
  const { data, error } = await supabase
    .from('event_impacts')
    .select('company_id, score_breakdown, companies(company_name, industry_name)')
    .eq('event_id', eventId);

  if (error) throw new Error(`앵커 조회 실패: ${error.message}`);

  type Joined = {
    company_id: string;
    score_breakdown: ScoreBreakdown;
    companies: { company_name: string; industry_name: string | null } | null;
  };

  return ((data ?? []) as unknown as Joined[])
    .filter((row) => typeof row.score_breakdown?.mention === 'number' && row.companies)
    .map((row) => ({
      companyId: row.company_id,
      companyName: row.companies!.company_name,
      industryName: row.companies!.industry_name,
    }));
}
