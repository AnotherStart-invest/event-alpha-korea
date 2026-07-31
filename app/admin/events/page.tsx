import Link from 'next/link';
import { Badge, EmptyState, Table, Td, Th } from '@/components/ui/primitives';
import { StatusBadge } from '@/components/domain/badges';
import { EVENT_STATUSES, EVENT_STATUS_LABELS, type EventStatus } from '@/lib/db/enums';
import { formatDateTime } from '@/lib/shared/format';
import { getReviewQueue } from '@/lib/queries/admin';

export const dynamic = 'force-dynamic';

export default async function AdminEventsPage(props: {
  searchParams: Promise<{ status?: string }>;
}) {
  const params = await props.searchParams;
  const status = EVENT_STATUSES.includes(params.status as EventStatus)
    ? (params.status as EventStatus)
    : undefined;

  let items: Awaited<ReturnType<typeof getReviewQueue>> = [];
  let failed: string | null = null;
  try {
    items = await getReviewQueue(status);
  } catch (err) {
    failed = err instanceof Error ? err.message : String(err);
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-bold tracking-tight">이벤트 검수</h1>
        <p className="mt-1 text-sm text-muted">
          승인해야 공개됩니다. 승인 전에는 어떤 사용자도 조회할 수 없습니다.
        </p>
      </div>

      <nav className="flex flex-wrap gap-1.5">
        <Link href="/admin/events">
          <Badge tone={!status ? 'positive' : 'outline'} className="px-2 py-1 text-xs">
            검수 관련 전체
          </Badge>
        </Link>
        {EVENT_STATUSES.map((value) => (
          <Link key={value} href={`/admin/events?status=${value}`}>
            <Badge tone={status === value ? 'positive' : 'outline'} className="px-2 py-1 text-xs">
              {EVENT_STATUS_LABELS[value]}
            </Badge>
          </Link>
        ))}
      </nav>

      {failed ? (
        <EmptyState title="조회에 실패했습니다" hint={failed} />
      ) : items.length === 0 ? (
        <EmptyState title="해당 상태의 이벤트가 없습니다" />
      ) : (
        <Table className="min-w-[48rem]">
          <thead>
            <tr>
              <Th>발생시각</Th>
              <Th>제목</Th>
              <Th>상태</Th>
              <Th className="text-right">확신도</Th>
              <Th className="text-right">종목</Th>
              <Th className="text-right">긍정/부정</Th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id}>
                <Td className="tnum whitespace-nowrap text-muted">
                  {formatDateTime(item.event_occurred_at)}
                </Td>
                <Td>
                  <Link
                    href={`/admin/events/${item.id}`}
                    className="font-medium hover:underline underline-offset-4"
                  >
                    {item.title}
                  </Link>
                  {item.last_error ? (
                    <p className="mt-0.5 max-w-md truncate text-[11px] text-negative">
                      {item.last_error}
                    </p>
                  ) : null}
                </Td>
                <Td>
                  <StatusBadge status={item.status} />
                </Td>
                <Td className="tnum text-right">{item.event_confidence ?? '—'}</Td>
                <Td className="tnum text-right">{item.impactCount}</Td>
                <Td className="tnum whitespace-nowrap text-right">
                  <span className="text-positive">{item.positiveCount}</span>
                  <span className="text-muted"> / </span>
                  <span className="text-negative">{item.negativeCount}</span>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}
