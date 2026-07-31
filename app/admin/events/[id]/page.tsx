import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  AddImpactForm,
  ImpactEditor,
  ReviewActions,
  SummaryEditor,
} from '@/components/admin/review-panel';
import { EventTypeBadge, StatusBadge } from '@/components/domain/badges';
import { Card, CardContent, SectionTitle } from '@/components/ui/primitives';
import { REQUIREMENT_TYPE_LABELS, TIME_HORIZON_LABELS } from '@/lib/db/enums';
import { formatDateTime } from '@/lib/shared/format';
import { getAuditTrail } from '@/lib/queries/admin';
import { getEventForReview } from '@/lib/queries/events';

export const dynamic = 'force-dynamic';

export default async function AdminEventDetailPage(props: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await props.params;

  const detail = await getEventForReview(id).catch(() => null);
  if (!detail) notFound();

  const { event, articles, steps, requirements, impacts } = detail;
  const audit = await getAuditTrail(id).catch(() => []);

  return (
    <div className="space-y-6">
      <header>
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={event.status} />
          <EventTypeBadge type={event.event_type} />
          <time className="tnum text-xs text-muted">{formatDateTime(event.event_occurred_at)}</time>
          {event.status === 'published' ? (
            <Link
              href={`/events/${event.id}`}
              className="text-xs text-accent hover:underline underline-offset-4"
            >
              공개 페이지 보기 ↗
            </Link>
          ) : null}
        </div>
        <h1 className="mt-2 text-lg font-bold leading-snug tracking-tight">{event.title}</h1>
        <p className="mt-1 text-xs text-muted">
          핵심변수 {event.primary_variable ?? '—'} ({event.variable_direction}) · 영향기간{' '}
          {TIME_HORIZON_LABELS[event.time_horizon]} · 확신도 {event.event_confidence ?? '—'} · 신규성{' '}
          {event.novelty_score ?? '—'}
        </p>
        {event.last_error ? (
          <p className="mt-2 rounded border border-negative/30 bg-negative-bg p-2 text-xs text-negative">
            마지막 오류: {event.last_error}
          </p>
        ) : null}
      </header>

      <ReviewActions eventId={event.id} status={event.status} />

      <section>
        <SectionTitle>사실 요약 수정</SectionTitle>
        <SummaryEditor eventId={event.id} title={event.title} summary={event.factual_summary} />
      </section>

      <section>
        <SectionTitle hint={`${articles.length}건`}>연결된 기사</SectionTitle>
        <Card>
          <CardContent className="pt-4">
            <ul className="space-y-1.5 text-sm">
              {articles.map((article) => (
                <li key={article.id}>
                  <a
                    href={article.original_url ?? '#'}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hover:underline underline-offset-4"
                  >
                    {article.title}
                  </a>
                  <span className="ml-2 text-xs text-muted">
                    {article.source_name} · {formatDateTime(article.published_at)}
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </section>

      <section>
        <SectionTitle hint={`${steps.length}단계`}>전파 경로</SectionTitle>
        <ol className="space-y-1.5 text-sm">
          {steps.map((step) => (
            <li key={step.id} className="flex gap-2">
              <span className="tnum text-xs text-muted">{step.step_order}</span>
              <span>{step.description}</span>
            </li>
          ))}
        </ol>
      </section>

      <section>
        <SectionTitle hint={`${impacts.length}종목`}>관련 종목 검수</SectionTitle>
        <ImpactEditor impacts={impacts} />
        <div className="mt-3">
          <p className="mb-1.5 text-xs text-muted">
            직접 추가 — 종목코드로만 조회하므로 존재하지 않는 종목은 추가되지 않습니다.
          </p>
          <AddImpactForm eventId={event.id} />
        </div>
      </section>

      <section className="grid gap-5 md:grid-cols-3">
        {(Object.keys(REQUIREMENT_TYPE_LABELS) as Array<keyof typeof REQUIREMENT_TYPE_LABELS>).map(
          (type) => {
            const items = requirements.filter((r) => r.requirement_type === type);
            return (
              <div key={type}>
                <SectionTitle>{REQUIREMENT_TYPE_LABELS[type]}</SectionTitle>
                {items.length === 0 ? (
                  <p className="text-xs text-muted">없음</p>
                ) : (
                  <ul className="space-y-1 text-xs leading-relaxed">
                    {items.map((item) => (
                      <li key={item.id}>· {item.description}</li>
                    ))}
                  </ul>
                )}
              </div>
            );
          },
        )}
      </section>

      {audit.length > 0 ? (
        <section>
          <SectionTitle>검수 이력</SectionTitle>
          <ul className="space-y-1 text-xs">
            {audit.map((row) => (
              <li key={row.id} className="flex gap-2 text-muted">
                <span className="tnum">{formatDateTime(row.created_at)}</span>
                <span className="font-medium text-foreground">{row.action}</span>
                {row.comment ? <span>· {row.comment}</span> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
