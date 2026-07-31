import Link from 'next/link';
import { Card, CardContent } from '@/components/ui/primitives';
import { EventTypeBadge, StatusBadge, VariableDirectionMark } from './badges';
import { formatDateTime } from '@/lib/shared/format';
import { TIME_HORIZON_LABELS } from '@/lib/db/enums';
import { isAnalyzed, type EventCard as EventCardData } from '@/lib/queries/events';

/** 메인/피드에 쓰는 이벤트 카드 (PRODUCT_SPEC §6.1) */
export function EventCard({ event, href }: { event: EventCardData; href?: string }) {
  // 분석 전 이벤트는 채울 값이 없는 칸(핵심 변수·확신도·긍정/부정)을 아예 감춘다.
  // 빈 칸을 늘어놓는 것보다 "관련 종목 n" 하나가 정직하다.
  const analyzed = isAnalyzed(event);

  return (
    <Card className="transition-colors hover:border-border-strong">
      <CardContent className="pt-4">
        <div className="flex flex-wrap items-center gap-2">
          <time className="tnum text-xs text-muted">{formatDateTime(event.event_occurred_at)}</time>
          <EventTypeBadge type={event.event_type} />
          <StatusBadge status={event.status} />
        </div>

        <h3 className="mt-2 text-base font-semibold leading-snug">
          <Link href={href ?? `/events/${event.id}`} className="hover:underline underline-offset-4">
            {event.title}
          </Link>
        </h3>

        {event.factual_summary ? (
          <p className="mt-1.5 line-clamp-2 text-sm leading-relaxed text-muted-strong">
            {event.factual_summary}
          </p>
        ) : null}

        {analyzed ? (
          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs sm:grid-cols-3">
            <div>
              <dt className="text-muted">핵심 변수</dt>
              <dd className="mt-0.5 flex items-center gap-1">
                <span className="truncate">{event.primary_variable ?? '—'}</span>
                <VariableDirectionMark direction={event.variable_direction} />
              </dd>
            </div>
            <div>
              <dt className="text-muted">영향 기간</dt>
              <dd className="mt-0.5">{TIME_HORIZON_LABELS[event.time_horizon]}</dd>
            </div>
            <div>
              <dt className="text-muted">분석 확신도</dt>
              <dd className="tnum mt-0.5">{event.event_confidence ?? '—'}</dd>
            </div>
          </dl>
        ) : null}

        {event.topCompanies.length > 0 ? (
          <ul className="mt-3 flex flex-wrap gap-1.5">
            {event.topCompanies.map((company) => (
              <li key={company.stockCode ?? company.name}>
                <span className="rounded border border-border bg-surface-muted px-1.5 py-0.5 text-xs">
                  {company.name}
                </span>
              </li>
            ))}
            {event.companyCount > event.topCompanies.length ? (
              <li className="self-center text-xs text-muted">
                외 {event.companyCount - event.topCompanies.length}
              </li>
            ) : null}
          </ul>
        ) : null}

        <div className="mt-3 flex items-center justify-between border-t border-border pt-2.5 text-xs">
          {analyzed ? (
            <div className="flex items-center gap-3">
              <span className="text-positive">
                긍정 <span className="tnum font-semibold">{event.positiveCount}</span>
              </span>
              <span className="text-negative">
                부정 <span className="tnum font-semibold">{event.negativeCount}</span>
              </span>
            </div>
          ) : (
            <span className="text-muted">
              관련 종목 <span className="tnum font-semibold text-foreground">{event.companyCount}</span>
            </span>
          )}
          <span className="text-muted">출처 {event.sourceCount}건</span>
        </div>
      </CardContent>
    </Card>
  );
}
