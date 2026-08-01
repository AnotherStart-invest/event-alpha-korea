import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { ImpactTable } from '@/components/domain/impact-table';
import { MentionTable } from '@/components/domain/mention-table';
import { ValueChainView } from '@/components/domain/value-chain';
import { InvestmentThesis, hasThesisContent } from '@/components/domain/investment-thesis';
import { EventTypeBadge, EvidenceBadge, VariableDirectionMark } from '@/components/domain/badges';
import { Card, CardContent, SectionTitle, Separator } from '@/components/ui/primitives';
import { TIME_HORIZON_LABELS } from '@/lib/db/enums';
import { formatDateTime } from '@/lib/shared/format';
import {
  VISIBLE_PER_STEP,
  buildValueChain,
  getPublishedEvent,
  groupImpacts,
  hasDirectionJudgement,
  isAnalyzed,
  isPeerImpact,
  type EventDetail,
  type ValueChain,
} from '@/lib/queries/events';
import { LiveQuoteProvider, LiveQuoteStamp } from '@/components/domain/live-quote';

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
  const chain = buildValueChain(detail.steps, detail.impacts);

  // 섹션 번호는 한 곳에서 센다. 각 컴포넌트가 알아서 매기면 서로 겹친다
  // (실제로 "01 투자 논리"와 "01 사건 요약"이 겹치고 02 가 비었다).
  const showThesis = hasThesisContent(detail.event, detail.steps, detail.requirements);
  const headerSections = (chain.hasChain ? 1 : 0) + (showThesis ? 1 : 0);

  // 화면에 뜨는 종목 전체를 한 번에 폴링한다. 종목마다 요청하면 20번이 된다.
  const codes = Array.from(
    new Set(
      detail.impacts.map((i) => i.company?.stock_code).filter((c): c is string => Boolean(c)),
    ),
  );

  return (
    <LiveQuoteProvider codes={codes}>
    <article className="space-y-8">
      {/* 헤더 */}
      <header>
        <div className="flex flex-wrap items-center gap-2">
          <time className="tnum text-xs text-muted">{formatDateTime(event.event_occurred_at)}</time>
          <EventTypeBadge type={event.event_type} />
        </div>
        <h1 className="mt-2 text-xl font-bold leading-snug tracking-tight">{event.title}</h1>
        <p className="mt-1"><LiveQuoteStamp /></p>

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

      {/*
        밸류체인은 isAnalyzed 와 **무관하게** 그린다.
        전파 경로(lib/events/transmission.ts)는 LLM 분석과 별개 경로라서,
        factual_summary 가 없는 이벤트에도 단계와 종목이 붙어 있다.
        이 분기를 isAnalyzed 에 묶어 뒀던 탓에 이미 쌓인 505개 단계가
        화면에 한 번도 나오지 못했고, 그 종목들이 "기사에 언급된 상장사" 라는
        틀린 제목 아래 섞여 나왔다 — 기사에 이름이 나온 적 없는 종목들이다.
      */}
      {chain.hasChain ? (
        <ValueChainSection detail={detail} chain={chain} />
      ) : null}

      {/*
        투자 논리는 **분석 여부와 무관하게** 그린다.
        재료(핵심 변수·전파 단계·확인 사항)가 AnalyzedSections 안에만 있어서,
        어떤 이벤트에는 전파 경로가 나오고 어떤 이벤트에는 아예 없었다.
      */}
      <InvestmentThesis
        event={event}
        steps={detail.steps}
        requirements={detail.requirements}
        index={chain.hasChain ? 2 : 1}
      />

      {isAnalyzed(event) ? (
        <AnalyzedSections detail={detail} offset={headerSections} />
      ) : (
        <MentionOnlySections detail={detail} offset={headerSections} />
      )}

      <p className="rounded-lg border border-border bg-surface-muted p-3 text-xs leading-relaxed text-muted">
        이 페이지는 자동 생성되었으며 오류가 포함될 수 있습니다. 특정 종목의 매수·매도를 추천하지
        않으며, 표시된 관련도는 데이터베이스상 근거의 강도를 나타낼 뿐 주가 전망이 아닙니다.
        반드시 원문 기사와 전자공시를 직접 확인하십시오.
      </p>
    </article>
    </LiveQuoteProvider>
  );
}

/** 밸류체인 — 이벤트가 어느 단계로 전이되고 각 단계에 누가 걸리는가. */
function ValueChainSection({ detail, chain }: { detail: EventDetail; chain: ValueChain }) {
  const shown = chain.lanes.reduce((sum, lane) => sum + lane.shown.length, 0);

  return (
    <section>
      <SectionTitle index={1} hint={`${chain.lanes.length}단계 · ${shown}종목`}>
        밸류체인 전이 경로
      </SectionTitle>
      <p className="mb-3 text-xs leading-relaxed text-muted">
        사건이 산업을 타고 번지는 순서입니다. 단계마다 관련도가 높은 순으로 최대{' '}
        {VISIBLE_PER_STEP}종목만 싣습니다. 경로는 AI 추정이고, 종목은 전자공시·거래소
        데이터에서 코드가 찾습니다 — AI 는 기업명을 출력할 수 없습니다.
      </p>
      <ValueChainView chain={chain} />
      <div className="mt-1">
        <EvidenceBadge kind="ai" />
      </div>
      {detail.event.primary_variable ? (
        <p className="mt-3 rounded-md border border-border bg-surface-muted px-3 py-2 text-xs text-muted-strong">
          핵심 변수: <strong className="text-foreground">{detail.event.primary_variable}</strong>
        </p>
      ) : null}
    </section>
  );
}

/**
 * 기사에 이름이 나온 종목만 붙어 있는 상태의 화면.
 *
 * 무료 티어에서는 LLM 분석 한도가 하루 10건이라 대부분의 이벤트가 여기 해당한다.
 * 전파 경로·방향 판정이 없으므로 그 섹션들을 빈 채로 늘어놓지 않고 감춘다.
 */
function MentionOnlySections({ detail, offset }: { detail: EventDetail; offset: number }) {
  const { articles, impacts } = detail;
  // 전파 경로로 붙은 종목은 위 밸류체인이 이미 보여줬다. 여기 또 넣으면
  // "기사에 언급된 상장사" 라는 제목이 거짓말이 된다 — 기사에 이름이 나온 적 없다.
  const rest = impacts.filter((impact) => impact.step_order === null);
  const peers = rest.filter(isPeerImpact);
  const mentioned = rest.filter((impact) => !isPeerImpact(impact));

  let cursor = offset;
  const next = () => ++cursor;
  const articlesNo = next();
  const mentionedNo = mentioned.length > 0 ? next() : 0;
  const peersNo = peers.length > 0 ? next() : 0;

  return (
    <>
      <section>
        <SectionTitle index={articlesNo} hint={`${articles.length}건`}>
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

      {mentioned.length > 0 ? (
        <section>
          <SectionTitle index={mentionedNo} hint={`${mentioned.length}종목`}>
            기사에 언급된 상장사
          </SectionTitle>
          <p className="mb-2 text-xs text-muted">
            기사 본문에 이름이 그대로 나온 종목입니다. 사전 대조로만 찾았으며, 영향의 방향이나
            크기는 판정하지 않았습니다.
          </p>
          <MentionTable impacts={mentioned} />
        </section>
      ) : null}

      {peers.length > 0 ? (
        <section>
          <SectionTitle index={peersNo} hint={`${peers.length}종목`}>
            같은 제품군 상장사
          </SectionTitle>
          <p className="mb-2 text-xs text-muted">
            위 종목과 주요제품이 겹쳐 같은 변수의 영향을 받을 수 있는 종목입니다.
            기사에 직접 언급되지는 않았고, 영향의 방향이나 크기도 판정하지 않았습니다.
          </p>
          <MentionTable impacts={peers} kind="peer" />
        </section>
      ) : null}
    </>
  );
}

/** 전체 분석이 끝난 이벤트의 화면 (PRODUCT_SPEC §6.2) */
function AnalyzedSections({ detail, offset }: { detail: EventDetail; offset: number }) {
  const { event, articles, impacts } = detail;
  // 밸류체인이 이미 보여준 종목은 아래 표에서 뺀다. 같은 종목을 두 번 세면
  // 화면이 길어지기만 하고 "몇 개가 관련 있나"라는 감각이 무너진다.
  const rest = offset > 0 ? impacts.filter((i) => i.step_order === null) : impacts;
  const groups = groupImpacts(rest);
  const judged = hasDirectionJudgement(rest);

  // 섹션 번호를 손으로 매기면 분기마다 어긋난다 — 전파 경로 섹션을 걷어냈을 때
  // 03 이 통째로 비는 구멍이 생겼다. 실제로 그릴 섹션만 순서대로 센다.
  let cursor = offset;
  const next = () => ++cursor;
  const summaryNo = next();
  const positiveNo = judged ? next() : 0;
  const negativeNo = judged ? next() : 0;
  const otherNo = judged ? 0 : next();
  const supplyChainNo = groups.supplyChain.length > 0 ? next() : 0;
  const thematicNo = groups.thematic.length > 0 ? next() : 0;

  return (
    <>
      {/* 1. 사건 요약 */}
      <section>
        <SectionTitle index={summaryNo} hint="기사에 명시된 사실만">
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

      <Separator />

      {/* 3~4. 방향을 판정했으면 긍정/부정으로 나누고, 아니면 한 표로 합친다 */}
      {judged ? (
        <>
          <section>
            <SectionTitle index={positiveNo} hint={`${groups.positive.length}종목`}>
              긍정 영향 가능성 종목
            </SectionTitle>
            <ImpactTable impacts={groups.positive} />
          </section>

          <section>
            <SectionTitle index={negativeNo} hint={`${groups.negative.length}종목`}>
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
          <SectionTitle index={otherNo} hint={`${groups.other.length}종목`}>
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
      {groups.supplyChain.length > 0 ? (
        <section>
          <SectionTitle index={supplyChainNo} hint="직접 실적 영향은 미확인">
            공급망 및 2차 관련 종목
          </SectionTitle>
          <ImpactTable impacts={groups.supplyChain} />
        </section>
      ) : null}

      {/* 6. 단순 테마 */}
      {groups.thematic.length > 0 ? (
      <section>
        <SectionTitle index={thematicNo} hint="근거 부족 · 낮은 신뢰도">
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
      ) : null}

      <Separator />

    </>
  );
}

