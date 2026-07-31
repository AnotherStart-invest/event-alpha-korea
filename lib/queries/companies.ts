import 'server-only';
import { createServerSupabase } from '@/lib/db/server';
import type { CompanyExposureRow, CompanyRow, EvidenceSourceRow } from '@/lib/db/types';
import type { ImpactDirection } from '@/lib/db/enums';

export type CompanyListItem = Pick<
  CompanyRow,
  'id' | 'company_name' | 'stock_code' | 'market' | 'industry_name' | 'verification_status'
> & { exposureCount: number };

export type CompanyDetail = {
  company: CompanyRow;
  exposures: Array<CompanyExposureRow & { evidence: EvidenceSourceRow | null }>;
  events: Array<{
    impactId: string;
    eventId: string;
    eventTitle: string;
    publishedAt: string | null;
    direction: ImpactDirection;
    relevanceScore: number;
    rationale: string | null;
  }>;
};

export async function searchCompanies(query: string, limit = 40): Promise<CompanyListItem[]> {
  const supabase = await createServerSupabase();

  let builder = supabase
    .from('companies')
    .select('id, company_name, stock_code, market, industry_name, verification_status, company_exposures(id)')
    .not('stock_code', 'is', null)
    .order('company_name')
    .limit(limit);

  const trimmed = query.trim();
  if (trimmed) {
    // 종목코드 6자리면 코드로, 아니면 이름으로 찾는다.
    builder = /^\d{1,6}$/.test(trimmed)
      ? builder.like('stock_code', `%${trimmed}%`)
      : builder.ilike('company_name', `%${trimmed}%`);
  }

  const { data, error } = await builder;
  if (error) throw new Error(`기업 검색 실패: ${error.message}`);

  type Joined = Omit<CompanyListItem, 'exposureCount'> & { company_exposures: Array<{ id: string }> | null };
  return ((data ?? []) as unknown as Joined[]).map((row) => ({
    id: row.id,
    company_name: row.company_name,
    stock_code: row.stock_code,
    market: row.market,
    industry_name: row.industry_name,
    verification_status: row.verification_status,
    exposureCount: (row.company_exposures ?? []).length,
  }));
}

export async function getCompanyByStockCode(stockCode: string): Promise<CompanyDetail | null> {
  const supabase = await createServerSupabase();

  const { data: company, error } = await supabase
    .from('companies')
    .select('*')
    .eq('stock_code', stockCode)
    .maybeSingle();

  if (error) throw new Error(`기업 조회 실패: ${error.message}`);
  if (!company) return null;

  const [exposuresResult, impactsResult] = await Promise.all([
    supabase
      .from('company_exposures')
      .select('*, evidence:evidence_sources(*)')
      .eq('company_id', company.id)
      .order('exposure_type'),
    supabase
      .from('event_impacts')
      .select(
        'id, impact_direction, relevance_score, rationale, event:events(id, title, published_at, status)',
      )
      .eq('company_id', company.id)
      .order('relevance_score', { ascending: false })
      .limit(30),
  ]);

  type RawExposure = CompanyExposureRow & { evidence: EvidenceSourceRow | EvidenceSourceRow[] | null };
  const exposures = ((exposuresResult.data ?? []) as unknown as RawExposure[]).map((row) => ({
    ...row,
    evidence: Array.isArray(row.evidence) ? (row.evidence[0] ?? null) : row.evidence,
  }));

  type RawImpact = {
    id: string;
    impact_direction: ImpactDirection;
    relevance_score: number;
    rationale: string | null;
    event: { id: string; title: string; published_at: string | null; status: string } | Array<{
      id: string;
      title: string;
      published_at: string | null;
      status: string;
    }> | null;
  };

  const events = ((impactsResult.data ?? []) as unknown as RawImpact[])
    .map((row) => {
      const event = Array.isArray(row.event) ? row.event[0] : row.event;
      if (!event) return null;
      return {
        impactId: row.id,
        eventId: event.id,
        eventTitle: event.title,
        publishedAt: event.published_at,
        direction: row.impact_direction,
        relevanceScore: row.relevance_score,
        rationale: row.rationale,
      };
    })
    .filter((e): e is CompanyDetail['events'][number] => e !== null);

  return { company: company as CompanyRow, exposures, events };
}
