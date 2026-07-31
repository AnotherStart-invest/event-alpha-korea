import Link from 'next/link';
import { PipelineButtons } from '@/components/admin/pipeline-buttons';
import { Card, CardContent, EmptyState, SectionTitle } from '@/components/ui/primitives';
import { EVENT_STATUS_LABELS, type EventStatus } from '@/lib/db/enums';
import { formatDateTime } from '@/lib/shared/format';
import { getDashboard } from '@/lib/queries/admin';

export const dynamic = 'force-dynamic';

/** 파이프라인이 이 시간 이상 안 돌면 경고를 띄운다. */
const STALE_MINUTES = 60;

export default async function AdminDashboardPage() {
  let dashboard: Awaited<ReturnType<typeof getDashboard>>;
  try {
    dashboard = await getDashboard();
  } catch (err) {
    return (
      <EmptyState
        title="대시보드를 불러오지 못했습니다"
        hint={err instanceof Error ? err.message : '환경변수와 마이그레이션을 확인하세요.'}
      />
    );
  }

  const stale = dashboard.pipelines.filter(
    (p) => p.minutesAgo === null || p.minutesAgo > STALE_MINUTES,
  );
  const budgetPct = dashboard.budget > 0 ? (dashboard.costToday / dashboard.budget) * 100 : 0;

  return (
    <div className="space-y-6">
      {stale.length > 0 ? (
        <div className="rounded-lg border border-negative/30 bg-negative-bg p-3 text-sm text-negative">
          <p className="font-medium">
            {stale.map((p) => p.job).join(', ')} 파이프라인이 {STALE_MINUTES}분 이상 실행되지
            않았습니다.
          </p>
          <p className="mt-1 text-xs">cron 설정 또는 CRON_SECRET 을 확인하세요.</p>
        </div>
      ) : null}

      <section>
        <SectionTitle>수동 실행</SectionTitle>
        <Card>
          <CardContent className="pt-4">
            <PipelineButtons />
          </CardContent>
        </Card>
      </section>

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="검수 대기" value={dashboard.counts.pending_review} href="/admin/events?status=pending_review" />
        <Stat label="공개됨" value={dashboard.counts.published} href="/admin/events?status=published" />
        <Stat label="분석 대기" value={dashboard.counts.candidate} />
        <Stat label="분석 실패" value={dashboard.counts.failed} href="/admin/events?status=failed" />
      </section>

      <section className="grid gap-4 md:grid-cols-2">
        <div>
          <SectionTitle>파이프라인 상태</SectionTitle>
          <Card>
            <CardContent className="pt-4">
              <ul className="space-y-2.5">
                {dashboard.pipelines.map((pipeline) => (
                  <li key={pipeline.job} className="flex items-baseline justify-between gap-3 text-sm">
                    <span className="font-medium">{pipeline.job}</span>
                    <span className="text-right text-xs">
                      {pipeline.lastRunAt ? (
                        <>
                          <span className={pipeline.lastOk === false ? 'text-negative' : 'text-muted'}>
                            {formatDateTime(pipeline.lastRunAt)}
                          </span>
                          <span className="tnum ml-2 text-muted">
                            ({pipeline.minutesAgo}분 전)
                          </span>
                        </>
                      ) : (
                        <span className="text-muted">실행 이력 없음</span>
                      )}
                      {pipeline.error ? (
                        <span className="mt-0.5 block max-w-[16rem] truncate text-negative">
                          {pipeline.error}
                        </span>
                      ) : null}
                    </span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </div>

        <div>
          <SectionTitle>비용 · 데이터</SectionTitle>
          <Card>
            <CardContent className="space-y-3 pt-4">
              <div>
                <div className="flex items-baseline justify-between text-sm">
                  <span>오늘 LLM 비용</span>
                  <span className="tnum">
                    ${dashboard.costToday.toFixed(4)}{' '}
                    <span className="text-muted">/ ${dashboard.budget.toFixed(2)}</span>
                  </span>
                </div>
                <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-surface-muted">
                  <div
                    className={budgetPct >= 100 ? 'h-full bg-negative' : 'h-full bg-positive'}
                    style={{ width: `${Math.min(budgetPct, 100)}%` }}
                  />
                </div>
              </div>
              <dl className="grid grid-cols-3 gap-2 border-t border-border pt-3 text-xs">
                <div>
                  <dt className="text-muted">미처리 기사</dt>
                  <dd className="tnum mt-0.5 text-sm">{dashboard.pendingArticles}</dd>
                </div>
                <div>
                  <dt className="text-muted">상장사</dt>
                  <dd className="tnum mt-0.5 text-sm">{dashboard.companies.total}</dd>
                </div>
                <div>
                  <dt className="text-muted">프로필 생성</dt>
                  <dd className="tnum mt-0.5 text-sm">{dashboard.companies.withProfile}</dd>
                </div>
              </dl>
              {dashboard.companies.withProfile === 0 ? (
                <p className="rounded border border-warn/30 bg-warn-bg p-2 text-xs text-warn">
                  기업 프로필이 없으면 관련 종목을 찾을 수 없습니다.{' '}
                  <code>python -m python.scripts.build_profiles --limit 50</code>
                </p>
              ) : null}
            </CardContent>
          </Card>
        </div>
      </section>

      <section>
        <SectionTitle>이벤트 상태 분포</SectionTitle>
        <div className="flex flex-wrap gap-2 text-xs">
          {(Object.keys(dashboard.counts) as EventStatus[]).map((status) => (
            <span key={status} className="rounded border border-border bg-surface px-2 py-1">
              {EVENT_STATUS_LABELS[status]}{' '}
              <span className="tnum font-semibold">{dashboard.counts[status]}</span>
            </span>
          ))}
        </div>
      </section>
    </div>
  );
}

function Stat({ label, value, href }: { label: string; value: number; href?: string }) {
  const content = (
    <Card className="transition-colors hover:border-border-strong">
      <CardContent className="pt-4">
        <p className="text-xs text-muted">{label}</p>
        <p className="tnum mt-1 text-2xl font-bold">{value}</p>
      </CardContent>
    </Card>
  );
  return href ? <Link href={href}>{content}</Link> : content;
}
