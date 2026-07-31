import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { DirectionBadge, EvidenceBadge } from '@/components/domain/badges';
import { Card, CardContent, SectionTitle, Table, Td, Th } from '@/components/ui/primitives';
import { EXPOSURE_TYPE_LABELS, type ExposureType } from '@/lib/db/enums';
import { formatDate, formatPercent } from '@/lib/shared/format';
import { getCompanyByStockCode } from '@/lib/queries/companies';

export const dynamic = 'force-dynamic';

export async function generateMetadata(props: {
  params: Promise<{ stockCode: string }>;
}): Promise<Metadata> {
  const { stockCode } = await props.params;
  try {
    const detail = await getCompanyByStockCode(stockCode);
    return { title: detail?.company.company_name ?? '기업' };
  } catch {
    return { title: '기업' };
  }
}

export default async function CompanyDetailPage(props: {
  params: Promise<{ stockCode: string }>;
}) {
  const { stockCode } = await props.params;
  const detail = await getCompanyByStockCode(stockCode).catch(() => null);
  if (!detail) notFound();

  const { company, exposures, events } = detail;
  const positive = events.filter((e) => e.direction === 'positive');
  const negative = events.filter((e) => e.direction === 'negative');

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-xl font-bold tracking-tight">{company.company_name}</h1>
        <p className="tnum mt-1 text-sm text-muted">
          {company.stock_code} · {company.market ?? '시장 미상'} · {company.industry_name ?? '업종 미상'}
        </p>
        {company.description ? (
          <p className="mt-3 max-w-3xl text-sm leading-relaxed text-muted-strong">
            {company.description}
          </p>
        ) : null}
        <dl className="mt-4 flex flex-wrap gap-x-8 gap-y-2 text-xs">
          <div>
            <dt className="text-muted">최신 사업보고서</dt>
            <dd className="mt-0.5">{formatDate(company.latest_report_date)}</dd>
          </div>
          <div>
            <dt className="text-muted">검수 상태</dt>
            <dd className="mt-0.5">{company.verification_status}</dd>
          </div>
          <div>
            <dt className="text-muted">마지막 갱신</dt>
            <dd className="mt-0.5">{formatDate(company.updated_at)}</dd>
          </div>
        </dl>
      </header>

      <section>
        <SectionTitle hint={`${exposures.length}건`}>주요 제품 및 노출도</SectionTitle>
        {exposures.length === 0 ? (
          <Card>
            <CardContent className="pt-4">
              <p className="text-sm text-muted">
                아직 사업 노출 정보가 없습니다. 이 기업은 이벤트 매칭 대상에 포함되지 않습니다.
              </p>
              <p className="mt-1 text-xs text-muted">
                <code>python -m python.scripts.build_profiles --stock-code {company.stock_code}</code>
              </p>
            </CardContent>
          </Card>
        ) : (
          <Table className="min-w-[40rem]">
            <thead>
              <tr>
                <Th>유형</Th>
                <Th>값</Th>
                <Th className="text-right">매출 비중</Th>
                <Th>지역</Th>
                <Th>근거</Th>
                <Th>확인일</Th>
              </tr>
            </thead>
            <tbody>
              {exposures.map((exposure) => (
                <tr key={exposure.id}>
                  <Td className="text-muted">
                    {EXPOSURE_TYPE_LABELS[exposure.exposure_type as ExposureType] ?? exposure.exposure_type}
                  </Td>
                  <Td className="font-medium">{exposure.exposure_value}</Td>
                  <Td className="tnum text-right">{formatPercent(exposure.revenue_share)}</Td>
                  <Td className="text-muted">{exposure.geography ?? '—'}</Td>
                  <Td>
                    {exposure.evidence ? (
                      <div className="space-y-0.5">
                        <EvidenceBadge kind={exposure.evidence.source_type === 'dart' ? 'dart' : 'news'} />
                        {exposure.evidence.source_url ? (
                          <a
                            href={exposure.evidence.source_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="block text-[11px] text-accent hover:underline underline-offset-2"
                          >
                            {exposure.evidence.source_title} ↗
                          </a>
                        ) : null}
                        {exposure.evidence.excerpt ? (
                          <p className="line-clamp-2 text-[11px] text-muted">
                            &ldquo;{exposure.evidence.excerpt}&rdquo;
                          </p>
                        ) : null}
                      </div>
                    ) : (
                      <EvidenceBadge kind="none" />
                    )}
                  </Td>
                  <Td className="text-muted">{formatDate(exposure.evidence?.source_date ?? null)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </section>

      <section className="grid gap-6 md:grid-cols-2">
        <EventList title="긍정 영향 가능성 이벤트" events={positive} />
        <EventList title="부정 영향 가능성 이벤트" events={negative} />
      </section>

      {events.length > 0 ? (
        <section>
          <SectionTitle hint={`${events.length}건`}>최근 연결 이벤트</SectionTitle>
          <ul className="space-y-2">
            {events.map((event) => (
              <li key={event.impactId} className="rounded-lg border border-border bg-surface p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <DirectionBadge direction={event.direction} />
                  <span className="tnum text-xs text-muted">관련도 {event.relevanceScore}</span>
                  <span className="text-xs text-muted">{formatDate(event.publishedAt)}</span>
                </div>
                <Link
                  href={`/events/${event.eventId}`}
                  className="mt-1 block text-sm font-medium hover:underline underline-offset-4"
                >
                  {event.eventTitle}
                </Link>
                {event.rationale ? (
                  <p className="mt-1 text-xs leading-relaxed text-muted-strong">{event.rationale}</p>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function EventList({
  title,
  events,
}: {
  title: string;
  events: Array<{ impactId: string; eventId: string; eventTitle: string; relevanceScore: number }>;
}) {
  return (
    <div>
      <SectionTitle hint={`${events.length}건`}>{title}</SectionTitle>
      {events.length === 0 ? (
        <p className="text-xs text-muted">해당 이벤트가 없습니다.</p>
      ) : (
        <ul className="space-y-1.5">
          {events.slice(0, 8).map((event) => (
            <li key={event.impactId} className="text-sm">
              <Link href={`/events/${event.eventId}`} className="hover:underline underline-offset-4">
                {event.eventTitle}
              </Link>
              <span className="tnum ml-2 text-xs text-muted">{event.relevanceScore}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
