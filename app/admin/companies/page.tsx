import Link from 'next/link';
import { EmptyState, Table, Td, Th } from '@/components/ui/primitives';
import { createServiceClient } from '@/lib/db/service';
import { VERIFICATION_STATUSES, type VerificationStatus } from '@/lib/db/enums';
import { formatDate } from '@/lib/shared/format';

export const dynamic = 'force-dynamic';

export default async function AdminCompaniesPage(props: {
  searchParams: Promise<{ q?: string; status?: string }>;
}) {
  const params = await props.searchParams;
  const supabase = createServiceClient();

  let query = supabase
    .from('companies')
    .select('id, company_name, stock_code, market, industry_name, verification_status, latest_report_date, company_exposures(id)')
    .not('stock_code', 'is', null)
    .order('company_name')
    .limit(60);

  if (params.q) query = query.ilike('company_name', `%${params.q}%`);
  if (VERIFICATION_STATUSES.includes(params.status as VerificationStatus)) {
    query = query.eq('verification_status', params.status as VerificationStatus);
  }

  const { data, error } = await query;

  type Row = {
    id: string;
    company_name: string;
    stock_code: string | null;
    market: string | null;
    industry_name: string | null;
    verification_status: string;
    latest_report_date: string | null;
    company_exposures: Array<{ id: string }> | null;
  };
  const rows = (data ?? []) as unknown as Row[];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-bold tracking-tight">기업 프로필</h1>
        <p className="mt-1 text-sm text-muted">
          노출 정보가 없는 기업은 이벤트 매칭 대상에 들어가지 않습니다.
        </p>
      </div>

      <form action="/admin/companies" className="flex flex-wrap gap-2">
        <input
          name="q"
          defaultValue={params.q ?? ''}
          placeholder="종목명"
          className="h-8 w-56 rounded-md border border-border-strong bg-background px-2.5 text-xs outline-none focus-visible:border-accent"
        />
        <select
          name="status"
          defaultValue={params.status ?? ''}
          className="h-8 rounded-md border border-border-strong bg-background px-2 text-xs"
        >
          <option value="">전체 검수 상태</option>
          <option value="unverified">unverified</option>
          <option value="auto">auto</option>
          <option value="reviewed">reviewed</option>
          <option value="rejected">rejected</option>
        </select>
        <button
          type="submit"
          className="h-8 rounded-md border border-border-strong px-3 text-xs hover:bg-surface-muted"
        >
          검색
        </button>
      </form>

      {error ? (
        <EmptyState title="조회 실패" hint={error.message} />
      ) : rows.length === 0 ? (
        <EmptyState
          title="기업이 없습니다"
          hint="python -m python.scripts.sync_companies 로 상장사를 먼저 적재하세요."
        />
      ) : (
        <Table className="min-w-[44rem]">
          <thead>
            <tr>
              <Th>종목명</Th>
              <Th>코드</Th>
              <Th>시장</Th>
              <Th className="text-right">노출</Th>
              <Th>검수</Th>
              <Th>최신 보고서</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <Td className="font-medium">
                  <Link href={`/admin/companies/${row.id}`} className="hover:underline underline-offset-4">
                    {row.company_name}
                  </Link>
                </Td>
                <Td className="tnum text-muted">{row.stock_code}</Td>
                <Td className="text-muted">{row.market ?? '—'}</Td>
                <Td className="tnum text-right">{(row.company_exposures ?? []).length}</Td>
                <Td className="text-muted">{row.verification_status}</Td>
                <Td className="text-muted">{formatDate(row.latest_report_date)}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}
