import Link from 'next/link';
import type { Metadata } from 'next';
import { EventCard } from '@/components/domain/event-card';
import { Badge, EmptyState } from '@/components/ui/primitives';
import { EVENT_TYPES, EVENT_TYPE_LABELS, type EventType } from '@/lib/db/enums';
import { listPublishedEvents } from '@/lib/queries/events';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: '이벤트' };

export default async function EventsPage(props: {
  searchParams: Promise<{ type?: string }>;
}) {
  const params = await props.searchParams;
  const selected = EVENT_TYPES.includes(params.type as EventType)
    ? (params.type as EventType)
    : undefined;

  let events: Awaited<ReturnType<typeof listPublishedEvents>> = [];
  let failed = false;
  try {
    events = await listPublishedEvents({ eventType: selected, limit: 60 });
  } catch {
    failed = true;
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-bold tracking-tight">이벤트</h1>
        <p className="mt-1 text-sm text-muted">승인된 이벤트를 시간순으로 표시합니다.</p>
      </div>

      <nav className="flex flex-wrap gap-1.5">
        <FilterChip href="/events" active={!selected} label="전체" />
        {EVENT_TYPES.map((type) => (
          <FilterChip
            key={type}
            href={`/events?type=${type}`}
            active={selected === type}
            label={EVENT_TYPE_LABELS[type]}
          />
        ))}
      </nav>

      {failed ? (
        <EmptyState title="데이터베이스에 연결할 수 없습니다" hint="환경변수를 확인하세요." />
      ) : events.length === 0 ? (
        <EmptyState title="해당 조건의 이벤트가 없습니다" />
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {events.map((event) => (
            <EventCard key={event.id} event={event} />
          ))}
        </div>
      )}
    </div>
  );
}

function FilterChip({ href, active, label }: { href: string; active: boolean; label: string }) {
  return (
    <Link href={href}>
      <Badge tone={active ? 'positive' : 'outline'} className="px-2 py-1 text-xs">
        {label}
      </Badge>
    </Link>
  );
}
