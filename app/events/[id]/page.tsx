import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { ImpactTable } from '@/components/domain/impact-table';
import { MentionTable } from '@/components/domain/mention-table';
import { EventTypeBadge, EvidenceBadge, VariableDirectionMark } from '@/components/domain/badges';
import { Card, CardContent, SectionTitle, Separator } from '@/components/ui/primitives';
import { REQUIREMENT_TYPE_LABELS, TIME_HORIZON_LABELS } from '@/lib/db/enums';
import { formatDateTime } from '@/lib/shared/format';
import {
  getPublishedEvent,
  groupImpacts,
  hasDirectionJudgement,
  isAnalyzed,
  type EventDetail,
} from '@/lib/queries/events';

export const dynamic = 'force-dynamic';

export async function generateMetadata(props: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await props.params;
  try {
    const detail = await getPublishedEvent(id);
    return { title: detail?.event.title ?? '이벤트' };
  } catch {
    return { title: '이벤트' };
  }
}

export default async function EventDetailPage(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;

  const detail = await getPublishedEvent(id).catch(() => null);
  // 미승인 이벤트는 RLS 에서 0행이 되므로 여기서 404 가 된다 (I8)
  if (!detail) notFound();

  const { event } = detail;

  return (
    <article className="space-y-8">
      {/* 헤더 */}
      <header>
        <div className="flex flex-wrap items-center gap-2">
          <time className="tnum text-xs text-muted">{formatDateTime(event.event_occurred_at)}</time>
          <EventTypeBadge type={event.event_type} />
        </div>
        <h1 className="mt-2 text-xl font-bold leading-snug tracking-tight">{event.title}</h1>

        {isAnalyzed(event) ? (
          <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 rounded-lg border border-border bg-surface p-4 text-sm sm:grid-cols-4">
            <div>
              <dt className="text-xs text-muted">핵심 변수</dt>
              <dd className="mt-0.5 flex items-center gap-1">
                {event.primary_variable ?? '—'}
                <VariableDirectionMark direction={event.variable_direction} />
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted">영향 기간</dt>
              <dd className="mt-0.5">{TIME_HORIZON_LABELS[event.time_horizon]}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">분석 확신도</dt>
              <dd className="tnum mt-0.5">{event.event_confidence ?? '—'} / 100</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">지역</dt>
              <dd className="mt-0.5">{event.geography.join(', ') || '—'}</dd>
            </div>
          </dl>
        ) : null}
      </header>

      {isAnalyzed(event) ? (
        <AnalyzedSections detail={detail} />
      ) : (
        <MentionOnlySections detail={detail} />
      )}

      <p className="rounded-lg border border-border bg-surface-muted p-3 text-xs leading-relaxed text-muted">
        이 페이지는 자동 생성되었으며 오류가 포함될 수 있습니다. 특정 종목의 매수·매도를 추천하지
        않으며, 표시된 관련도는 데이터베이스상 근거의 강도를 나타낼 뿐 주가 전망이 아닙니다.
        반드시 원문 기사와 전자공시를 직접 확인하십시오.
      </p>
    </article>
  );
}

/**
 * 기사에 이름이 나온 종목만 붙어 있는 상태의 화면.
 *
 * 무료 티어에서는 LLM 분석 한도가 하루 10건이라 대부분의 이벤트가 여기 해당한다.
 * 전파 경로·방향 판정이 없으므로 그 섹션들을 빈 채로 늘어놓지 않고 감춘다.
 */
function MentionOnlySections({ detail }: { detail: EventDetail }) {
  const { articles, impacts } = detail;

  return (
    <>
      <section>
        <SectionTitle index={1} hint={`${articles.length}건`}>
          관련 기사
        </SectionTitle>
        <Card>
          <CardContent className="pt-4">
            <ul className="space-y-2">
              {articles.map((article) => (
                <li key={article.id} className="text-sm leading-relaxed">
                  <a
                    href={article.original_url ?? '#'}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hover:underline underline-offset-2"
                  >
                    {article.title}
                  </a>
                  <span className="ml-1.5 text-xs text-muted">{article.source_name ?? '출처'} ↗</span>
                </li>
              ))}
            </ul>
            <div className="mt-3 border-t border-border pt-3">
              <EvidenceBadge kind="news" />
            </div>
          </CardContent>
        </Card>
      </section>

      <section>
        <SectionTitle index={2} hint={`${impacts.length}종목`}>
          기사에 언급된 상장사
        </SectionTitle>
        <p className="mb-2 text-xs text-muted">
          기사 본문에 이름이 그대로 나온 종목입니다. 사전 대조로만 찾았으며, 영향의 방향이나
          크기는 판정하지 않았습니다.
        </p>
        <MentionTable impacts={impacts} />
      </section>
    </>
  );
}

/** 전체 분석이 끝난 이벤트의 화면 (PRODUCT_SPEC §6.2) */
function AnalyzedSections({ detail }: { detail: EventDetail }) {
  const { event, articles, steps, requirements, impacts } = detail;
  const groups = groupImpacts(impacts);
  const judged = hasDirectionJudgement(impacts);
  const byType = (type: keyof typeof REQUIREMENT_TYPE_LABELS) =>
    requirements.filter((r) => r.requirement_type === type);

  return (
    <>
      {/* 1. 사건 요약 */}
      <section>
        <SectionTitle index={1} hint="기사에 명시된 사실만">
          사건 요약
        </SectionTitle>
        <Card>
          <CardContent className="pt-4">
            <p className="text-sm leading-relaxed">{event.factual_summary ?? '요약이 없습니다.'}</p>
            <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3">
              <EvidenceBadge kind="news" />
              <span className="text-xs text-muted">원문:</span>
              {articles.map((article) => (
                <a
                  key={article.id}
                  href={article.original_url ?? '#'}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-accent hover:underline underline-offset-2"
                >
                  {article.source_name ?? '출처'} ↗
                </a>
              ))}
            </div>
          </CardContent>
        </Card>
      </section>

      {/* 2. 경제적 전파 경로 */}
      <section>
        <SectionTitle index={2} hint="AI 추정">
          경제적 전파 경로
        </SectionTitle>
        {steps.length === 0 ? (
          <p className="text-xs text-muted">전파 경로가 생성되지 않았습니다.</p>
        ) : (
          <ol className="space-y-0">
            {steps.map((step, index) => (
              <li key={step.id} className="flex gap-3">
                <div className="flex flex-col items-center">
                  <span className="tnum flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-border-strong bg-surface text-[11px] font-semibold">
                    {step.step_order}
                  </span>
                  {index < steps.length - 1 ? <span className="w-px flex-1 bg-border" /> : null}
                </div>
                <p className="pb-4 pt-0.5 text-sm leading-relaxed">{step.description}</p>
              </li>
            ))}
          </ol>
        )}
        <div className="mt-1">
          <EvidenceBadge kind="ai" />
        </div>
      </section>

      <Separator />

      {/* 3~4. 방향을 판정했으면 긍정/부정으로 나누고, 아니면 한 표로 합친다 */}
      {judged ? (
        <>
          <section>
            <SectionTitle index={3} hint={`${groups.positive.length}종목`}>
              긍정 영향 가능성 종목
            </SectionTitle>
            <ImpactTable impacts={groups.positive} />
          </section>

          <section>
            <SectionTitle index={4} hint={`${groups.negative.length}종목`}>
              부정 영향 가능성 종목
            </SectionTitle>
            <ImpactTable impacts={groups.negative} />
          </section>

          {groups.other.length > 0 ? (
            <section>
              <SectionTitle hint={`${groups.other.length}종목`}>방향이 불확실한 종목</SectionTitle>
              <ImpactTable impacts={groups.other} />
            </section>
          ) : null}
        </>
      ) : (
        <section>
          <SectionTitle index={3} hint={`${groups.other.length}종목`}>
            영향 범위가 겹치는 종목
          </SectionTitle>
          <p className="mb-2 text-xs text-muted">
            이 이벤트가 건드리는 제품·원재료·산업이 사업 내용과 겹치는 종목입니다. 어느 방향으로
            얼마나 영향을 받는지는 판정하지 않았습니다.
          </p>
          <ImpactTable impacts={groups.other} />
        </section>
      )}

      {/* 5. 공급망 및 2차 */}
      <section>
        <SectionTitle index={5} hint="직접 실적 영향은 미확인">
          공급망 및 2차 관련 종목
        </SectionTitle>
        <ImpactTable impacts={groups.supplyChain} />
      </section>

      {/* 6. 단순 테마 */}
      <section>
        <SectionTitle index={6} hint="근거 부족 · 낮은 신뢰도">
          단순 테마 종목
        </SectionTitle>
        <details className="rounded-lg border border-dashed border-border-strong">
          <summary className="cursor-pointer px-4 py-2.5 text-xs text-muted-strong">
            키워드·산업분류상 관련만 확인된 {groups.thematic.length}종목 펼치기
          </summary>
          <div className="border-t border-border p-3">
            <p className="mb-3 text-xs text-warn">
              매출·고객·수주 등 직접 근거가 확인되지 않은 그룹입니다. 관련도 점수가 39점으로 제한됩니다.
            </p>
            <ImpactTable impacts={groups.thematic} />
          </div>
        </details>
      </section>

      <Separator />

      {/* 7~9. 확인 사항 */}
      <section className="grid gap-6 md:grid-cols-3">
        <RequirementList index={7} type="evidence_to_check" items={byType('evidence_to_check')} />
        <RequirementList
          index={8}
          type="invalidation_condition"
          items={byType('invalidation_condition')}
        />
        <RequirementList index={9} type="follow_up_event" items={byType('follow_up_event')} />
      </section>
    </>
  );
}

function RequirementList({
  index,
  type,
  items,
}: {
  index: number;
  type: keyof typeof REQUIREMENT_TYPE_LABELS;
  items: Array<{ id: string; description: string }>;
}) {
  return (
    <div>
      <SectionTitle index={index}>{REQUIREMENT_TYPE_LABELS[type]}</SectionTitle>
      {items.length === 0 ? (
        <p className="text-xs text-muted">항목이 없습니다.</p>
      ) : (
        <ul className="space-y-1.5">
          {items.map((item) => (
            <li key={item.id} className="flex gap-2 text-sm leading-relaxed">
              <span className="text-muted">·</span>
              <span>{item.description}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
