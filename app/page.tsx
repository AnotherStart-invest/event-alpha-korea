import Link from 'next/link';
import { EventCard } from '@/components/domain/event-card';
import { EmptyState, SectionTitle } from '@/components/ui/primitives';
import { listPublishedEvents } from '@/lib/queries/events';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  let events: Awaited<ReturnType<typeof listPublishedEvents>> = [];
  let failed = false;

  try {
    events = await listPublishedEvents({ limit: 12 });
  } catch {
    failed = true;
  }

  const strongPositive = [...events]
    .filter((e) => e.positiveCount > 0)
    .sort((a, b) => b.positiveCount - a.positiveCount)
    .slice(0, 3);
  const strongNegative = [...events]
    .filter((e) => e.negativeCount > 0)
    .sort((a, b) => b.negativeCount - a.negativeCount)
    .slice(0, 3);

  return (
    <div className="space-y-8">
      <section>
        <h1 className="text-lg font-bold tracking-tight">최신 이벤트</h1>
        <p className="mt-1 text-sm text-muted">
          뉴스에서 투자 관련 사건을 추출하고, 경제적 전파 경로를 따라 근거가 있는 국내 상장 종목을
          연결합니다. 관리자 승인을 거친 이벤트만 표시됩니다.
        </p>
      </section>

      {failed ? (
        <EmptyState
          title="데이터베이스에 연결할 수 없습니다"
          hint="환경변수(.env.local)와 Supabase 마이그레이션 적용 여부를 확인하세요."
        />
      ) : events.length === 0 ? (
        <EmptyState
          title="아직 공개된 이벤트가 없습니다"
          hint="관리자 화면에서 뉴스 수집 → 분석 → 승인을 진행하세요."
        />
      ) : (
        <>
          <section>
            <div className="grid gap-3 md:grid-cols-2">
              {events.slice(0, 8).map((event) => (
                <EventCard key={event.id} event={event} />
              ))}
            </div>
            <div className="mt-3 text-right">
              <Link href="/events" className="text-xs text-accent hover:underline underline-offset-4">
                전체 이벤트 보기 →
              </Link>
            </div>
          </section>

          {strongPositive.length > 0 || strongNegative.length > 0 ? (
            <section className="grid gap-6 md:grid-cols-2">
              <div>
                <SectionTitle hint="긍정 영향 종목이 많은 순">긍정 영향이 강한 이벤트</SectionTitle>
                <ul className="space-y-1.5">
                  {strongPositive.map((event) => (
                    <li key={event.id} className="text-sm">
                      <Link href={`/events/${event.id}`} className="hover:underline underline-offset-4">
                        {event.title}
                      </Link>
                      <span className="tnum ml-2 text-xs text-positive">+{event.positiveCount}</span>
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <SectionTitle hint="부정 영향 종목이 많은 순">부정 영향이 강한 이벤트</SectionTitle>
                <ul className="space-y-1.5">
                  {strongNegative.map((event) => (
                    <li key={event.id} className="text-sm">
                      <Link href={`/events/${event.id}`} className="hover:underline underline-offset-4">
                        {event.title}
                      </Link>
                      <span className="tnum ml-2 text-xs text-negative">-{event.negativeCount}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}
