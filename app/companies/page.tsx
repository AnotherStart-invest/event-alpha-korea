import Link from 'next/link';
import type { Metadata } from 'next';
import { EmptyState, Table, Td, Th } from '@/components/ui/primitives';
import { searchCompanies } from '@/lib/queries/companies';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: '기업' };

export default async function CompaniesPage(props: {
  searchParams: Promise<{ q?: string }>;
}) {
  const params = await props.searchParams;
  const query = params.q ?? '';

  let companies: Awaited<ReturnType<typeof searchCompanies>> = [];
  let failed = false;
  try {
    companies = await searchCompanies(query);
  } catch {
    failed = true;
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-bold tracking-tight">기업</h1>
        <p className="mt-1 text-sm text-muted">
          국내 상장사만 표시합니다. 종목코드가 없는 법인은 서비스에 노출하지 않습니다.
        </p>
      </div>

      <form action="/companies" className="flex gap-2">
        <input
          type="search"
          name="q"
          defaultValue={query}
          placeholder="종목명 또는 종목코드"
          className="h-9 w-full max-w-sm rounded-md border border-border-strong bg-background px-3 text-sm outline-none focus-visible:border-accent"
        />
        <button
          type="submit"
          className="h-9 rounded-md bg-foreground px-4 text-sm font-medium text-white hover:bg-foreground/85"
        >
          검색
        </button>
      </form>

      {failed ? (
        <EmptyState title="데이터베이스에 연결할 수 없습니다" />
      ) : companies.length === 0 ? (
        <EmptyState
          title="기업이 없습니다"
          hint="python -m python.scripts.sync_companies 로 상장사 마스터를 먼저 적재하세요."
        />
      ) : (
        <Table className="min-w-[36rem]">
          <thead>
            <tr>
              <Th>종목명</Th>
              <Th>코드</Th>
              <Th>시장</Th>
              <Th>업종</Th>
              <Th className="text-right">노출 정보</Th>
              <Th>검수 상태</Th>
            </tr>
          </thead>
          <tbody>
            {companies.map((company) => (
              <tr key={company.id}>
                <Td className="font-medium">
                  <Link
                    href={`/companies/${company.stock_code}`}
                    className="hover:underline underline-offset-4"
                  >
                    {company.company_name}
                  </Link>
                </Td>
                <Td className="tnum text-muted">{company.stock_code}</Td>
                <Td className="text-muted">{company.market ?? '—'}</Td>
                <Td className="text-muted">{company.industry_name ?? '—'}</Td>
                <Td className="tnum text-right">{company.exposureCount}</Td>
                <Td className="text-muted">{company.verification_status}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}
