'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Badge, Button, Card, CardContent, Td, Th } from '@/components/ui/primitives';
import { ScoreCell } from '@/components/domain/score';
import { RelationBadge } from '@/components/domain/badges';
import {
  IMPACT_DIRECTIONS,
  IMPACT_DIRECTION_LABELS,
  RELATION_TYPES,
  RELATION_TYPE_LABELS,
  type EventStatus,
  type ImpactDirection,
  type RelationType,
} from '@/lib/db/enums';
import {
  addImpact,
  approveEvent,
  reanalyzeEvent,
  rejectEvent,
  removeImpact,
  unpublishEvent,
  updateEventSummary,
  updateImpact,
} from '@/lib/admin/actions';
import type { ImpactWithCompany } from '@/lib/queries/events';

type Feedback = { tone: 'ok' | 'error'; text: string } | null;

export function ReviewActions({ eventId, status }: { eventId: string; status: EventStatus }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [comment, setComment] = useState('');

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>) =>
    startTransition(async () => {
      const result = await fn();
      setFeedback(
        result.ok ? { tone: 'ok', text: '적용했습니다.' } : { tone: 'error', text: result.error ?? '실패' },
      );
      if (result.ok) router.refresh();
    });

  return (
    <Card>
      <CardContent className="space-y-3 pt-4">
        <div className="flex flex-wrap gap-2">
          {status !== 'published' ? (
            <Button variant="positive" size="sm" disabled={pending} onClick={() => run(() => approveEvent(eventId))}>
              승인하고 공개
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() => run(() => unpublishEvent(eventId, comment || '관리자 공개 취소'))}
            >
              공개 취소
            </Button>
          )}
          <Button
            variant="negative"
            size="sm"
            disabled={pending}
            onClick={() => run(() => rejectEvent(eventId, comment || '관리자 반려'))}
          >
            반려
          </Button>
          <Button variant="outline" size="sm" disabled={pending} onClick={() => run(() => reanalyzeEvent(eventId))}>
            재분석 대기열로
          </Button>
        </div>

        <input
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder="반려·취소 사유 (선택)"
          className="h-8 w-full rounded-md border border-border-strong bg-background px-2.5 text-xs outline-none focus-visible:border-accent"
        />

        {feedback ? (
          <p className={feedback.tone === 'ok' ? 'text-xs text-positive' : 'text-xs text-negative'}>
            {feedback.text}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function SummaryEditor({
  eventId,
  title,
  summary,
}: {
  eventId: string;
  title: string;
  summary: string | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [draftTitle, setDraftTitle] = useState(title);
  const [draftSummary, setDraftSummary] = useState(summary ?? '');

  function save() {
    startTransition(async () => {
      const result = await updateEventSummary(eventId, {
        title: draftTitle,
        factual_summary: draftSummary,
      });
      setFeedback(result.ok ? { tone: 'ok', text: '저장했습니다.' } : { tone: 'error', text: result.error });
      if (result.ok) router.refresh();
    });
  }

  const dirty = draftTitle !== title || draftSummary !== (summary ?? '');

  return (
    <Card>
      <CardContent className="space-y-2 pt-4">
        <label className="block text-xs text-muted">제목</label>
        <input
          value={draftTitle}
          onChange={(e) => setDraftTitle(e.target.value)}
          className="h-9 w-full rounded-md border border-border-strong bg-background px-3 text-sm outline-none focus-visible:border-accent"
        />
        <label className="block text-xs text-muted">사실 요약</label>
        <textarea
          value={draftSummary}
          onChange={(e) => setDraftSummary(e.target.value)}
          rows={4}
          className="w-full rounded-md border border-border-strong bg-background px-3 py-2 text-sm leading-relaxed outline-none focus-visible:border-accent"
        />
        <div className="flex items-center gap-2">
          <Button size="sm" disabled={!dirty || pending} onClick={save}>
            저장
          </Button>
          {feedback ? (
            <span className={feedback.tone === 'ok' ? 'text-xs text-positive' : 'text-xs text-negative'}>
              {feedback.text}
            </span>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

export function ImpactEditorRow({ impact }: { impact: ImpactWithCompany }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [direction, setDirection] = useState<ImpactDirection>(impact.impact_direction);
  const [relation, setRelation] = useState<RelationType>(impact.relation_type);
  const [score, setScore] = useState(String(impact.relevance_score));
  const [error, setError] = useState<string | null>(null);

  const dirty =
    direction !== impact.impact_direction ||
    relation !== impact.relation_type ||
    Number(score) !== impact.relevance_score;

  function save() {
    startTransition(async () => {
      const result = await updateImpact(impact.id, {
        impact_direction: direction,
        relation_type: relation,
        relevance_score: Number(score),
      });
      setError(result.ok ? null : result.error);
      if (result.ok) router.refresh();
    });
  }

  function remove() {
    startTransition(async () => {
      const result = await removeImpact(impact.id);
      setError(result.ok ? null : result.error);
      if (result.ok) router.refresh();
    });
  }

  return (
    <tr className="align-top">
      <Td className="font-medium">
        {impact.company?.company_name ?? '—'}
        <span className="tnum ml-1.5 text-xs text-muted">{impact.company?.stock_code}</span>
        {impact.evidence.length === 0 ? (
          <Badge tone="warn" className="ml-1.5">
            근거 없음
          </Badge>
        ) : null}
      </Td>
      <Td>
        <select
          value={direction}
          onChange={(e) => setDirection(e.target.value as ImpactDirection)}
          className="h-7 rounded border border-border-strong bg-background px-1.5 text-xs"
        >
          {IMPACT_DIRECTIONS.map((value) => (
            <option key={value} value={value}>
              {IMPACT_DIRECTION_LABELS[value]}
            </option>
          ))}
        </select>
      </Td>
      <Td>
        <select
          value={relation}
          onChange={(e) => setRelation(e.target.value as RelationType)}
          className="h-7 rounded border border-border-strong bg-background px-1.5 text-xs"
        >
          {RELATION_TYPES.map((value) => (
            <option key={value} value={value}>
              {RELATION_TYPE_LABELS[value]}
            </option>
          ))}
        </select>
      </Td>
      <Td>
        <div className="flex items-center gap-1.5">
          <input
            type="number"
            min={0}
            max={100}
            value={score}
            onChange={(e) => setScore(e.target.value)}
            className="tnum h-7 w-16 rounded border border-border-strong bg-background px-1.5 text-xs"
          />
          <ScoreCell score={impact.relevance_score} breakdown={impact.score_breakdown} />
        </div>
      </Td>
      <Td className="max-w-sm">
        <p className="text-xs leading-relaxed">{impact.rationale ?? '—'}</p>
        {error ? <p className="mt-1 text-[11px] text-negative">{error}</p> : null}
      </Td>
      <Td>
        <div className="flex gap-1">
          <Button size="sm" variant="outline" disabled={!dirty || pending} onClick={save}>
            저장
          </Button>
          <Button size="sm" variant="ghost" disabled={pending} onClick={remove}>
            삭제
          </Button>
        </div>
      </Td>
    </tr>
  );
}

export function ImpactEditor({ impacts }: { impacts: ImpactWithCompany[] }) {
  if (impacts.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-xs text-muted">
        연결된 종목이 없습니다. 아래에서 직접 추가할 수 있습니다.
      </p>
    );
  }
  return (
    <div className="scroll-x rounded-lg border border-border">
      <table className="w-full min-w-[56rem] text-sm">
        <thead>
          <tr>
            <Th>종목</Th>
            <Th>영향 방향</Th>
            <Th>관계</Th>
            <Th>관련도</Th>
            <Th>근거</Th>
            <Th>작업</Th>
          </tr>
        </thead>
        <tbody>
          {impacts.map((impact) => (
            <ImpactEditorRow key={impact.id} impact={impact} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function AddImpactForm({ eventId }: { eventId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [stockCode, setStockCode] = useState('');
  const [direction, setDirection] = useState<ImpactDirection>('positive');
  const [rationale, setRationale] = useState('');
  const [feedback, setFeedback] = useState<Feedback>(null);

  function submit(event: React.FormEvent) {
    event.preventDefault();
    startTransition(async () => {
      const result = await addImpact(eventId, stockCode, direction, rationale);
      setFeedback(
        result.ok ? { tone: 'ok', text: '추가했습니다.' } : { tone: 'error', text: result.error },
      );
      if (result.ok) {
        setStockCode('');
        setRationale('');
        router.refresh();
      }
    });
  }

  return (
    <form onSubmit={submit} className="flex flex-wrap items-start gap-2">
      <input
        value={stockCode}
        onChange={(e) => setStockCode(e.target.value)}
        placeholder="종목코드 6자리"
        required
        className="tnum h-8 w-32 rounded-md border border-border-strong bg-background px-2.5 text-xs outline-none focus-visible:border-accent"
      />
      <select
        value={direction}
        onChange={(e) => setDirection(e.target.value as ImpactDirection)}
        className="h-8 rounded-md border border-border-strong bg-background px-2 text-xs"
      >
        {IMPACT_DIRECTIONS.map((value) => (
          <option key={value} value={value}>
            {IMPACT_DIRECTION_LABELS[value]}
          </option>
        ))}
      </select>
      <input
        value={rationale}
        onChange={(e) => setRationale(e.target.value)}
        placeholder="연결 근거 (필수)"
        required
        className="h-8 min-w-[16rem] flex-1 rounded-md border border-border-strong bg-background px-2.5 text-xs outline-none focus-visible:border-accent"
      />
      <Button type="submit" size="sm" disabled={pending}>
        추가
      </Button>
      {feedback ? (
        <span className={feedback.tone === 'ok' ? 'text-xs text-positive' : 'text-xs text-negative'}>
          {feedback.text}
        </span>
      ) : null}
    </form>
  );
}

export { RelationBadge };
