import Link from 'next/link';
import { notFound } from 'next/navigation';
import { EvidenceBadge } from '@/components/domain/badges';
import { ExposureEditor } from '@/components/admin/exposure-editor';
import { SectionTitle, Table, Td, Th } from '@/components/ui/primitives';
import { EXPOSURE_TYPE_LABELS, type ExposureType } from '@/lib/db/enums';
import { createServiceClient } from '@/lib/db/service';
import { formatDate, formatPercent } from '@/lib/shared/format';

export const dynamic = 'force-dynamic';

export default async function AdminCompanyDetailPage(props: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await props.params;
  const supabase = createServiceClient();

  const { data: company } = await supabase.from('companies').select('*').eq('id', id).maybeSingle();
  if (!company) notFound();

  const { data: exposures } = await supabase
    .from('company_exposures')
    .select('*, evidence:evidence_sources(id, source_type, source_title, source_url, source_date, excerpt)')
    .eq('company_id', id)
    .order('exposure_type');

  type Row = {
    id: string;
    exposure_type: string;
    exposure_value: string;
    normalized_value: string;
    revenue_share: number | null;
    geography: string | null;
    verified: boolean;
    evidence: {
      id: string;
      source_type: string;
      source_title: string;
      source_url: string | null;
      source_date: string | null;
      excerpt: string | null;
    } | null;
  };
  const rows = (exposures ?? []) as unknown as Row[];

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-lg font-bold tracking-tight">{company.company_name}</h1>
        <p className="tnum mt-1 text-sm text-muted">
          {company.stock_code} · {company.market ?? '—'} · corp_code {company.corp_code ?? '—'}
        </p>
        <p className="mt-1 text-xs text-muted">
          검수 상태 {company.verification_status} · 최신 보고서{' '}
          {formatDate(company.latest_report_date)}
        </p>
        {company.stock_code ? (
          <Link
            href={`/companies/${company.stock_code}`}
            className="mt-2 inline-block text-xs text-accent hover:underline underline-offset-4"
          >
            공개 페이지 보기 ↗
          </Link>
        ) : null}
      </header>

      {company.description ? (
        <section>
          <SectionTitle>사업 설명</SectionTitle>
          <p className="max-w-3xl text-sm leading-relaxed text-muted-strong">{company.description}</p>
        </section>
      ) : null}

      <section>
        <SectionTitle hint={`${rows.length}건`}>사업 노출 정보</SectionTitle>
        <p className="mb-2 text-xs text-muted">
          &ldquo;검수 완료&rdquo;로 표시하면 공시 근거 점수가 10점에서 15점으로 올라갑니다.
        </p>
        {rows.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-xs text-muted">
            노출 정보가 없습니다.{' '}
            <code>python -m python.scripts.build_profiles --stock-code {company.stock_code}</code>
          </p>
        ) : (
          <Table className="min-w-[52rem]">
            <thead>
              <tr>
                <Th>유형</Th>
                <Th>값</Th>
                <Th className="text-right">매출비중</Th>
                <Th>지역</Th>
                <Th>근거</Th>
                <Th>검수</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="align-top">
                  <Td className="text-muted">
                    {EXPOSURE_TYPE_LABELS[row.exposure_type as ExposureType] ?? row.exposure_type}
                  </Td>
                  <Td className="font-medium">
                    {row.exposure_value}
                    <p className="text-[11px] text-muted">{row.normalized_value}</p>
                  </Td>
                  <Td className="tnum text-right">{formatPercent(row.revenue_share)}</Td>
                  <Td className="text-muted">{row.geography ?? '—'}</Td>
                  <Td className="max-w-sm">
                    {row.evidence ? (
                      <div className="space-y-0.5">
                        <EvidenceBadge kind={row.evidence.source_type === 'dart' ? 'dart' : 'news'} />
                        {row.evidence.excerpt ? (
                          <p className="text-[11px] leading-snug text-muted">
                            &ldquo;{row.evidence.excerpt}&rdquo;
                          </p>
                        ) : null}
                        {row.evidence.source_url ? (
                          <a
                            href={row.evidence.source_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-[11px] text-accent hover:underline underline-offset-2"
                          >
                            원문 ↗
                          </a>
                        ) : null}
                      </div>
                    ) : (
                      <EvidenceBadge kind="none" />
                    )}
                  </Td>
                  <Td>
                    <ExposureEditor exposureId={row.id} verified={row.verified} />
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </section>
    </div>
  );
}
