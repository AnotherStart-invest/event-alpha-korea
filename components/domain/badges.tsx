import { Badge } from '@/components/ui/primitives';
import { cn } from '@/lib/shared/cn';
import {
  EVENT_STATUS_LABELS,
  EVENT_TYPE_LABELS,
  IMPACT_DIRECTION_LABELS,
  IMPACT_LEVEL_LABELS,
  RELATION_TYPE_LABELS,
  TIME_HORIZON_LABELS,
  type EventStatus,
  type EventType,
  type ImpactDirection,
  type ImpactLevel,
  type RelationType,
  type TimeHorizon,
  type VariableDirection,
} from '@/lib/db/enums';

/** 근거 배지 4종 (PRODUCT_SPEC §8) */
export type EvidenceKind = 'dart' | 'news' | 'ai' | 'none';

const EVIDENCE_LABEL: Record<EvidenceKind, string> = {
  dart: '공시 확인',
  news: '기사 확인',
  ai: 'AI 추정',
  none: '근거 부족',
};

export function EvidenceBadge({ kind, className }: { kind: EvidenceKind; className?: string }) {
  const tone = kind === 'dart' ? 'positive' : kind === 'none' ? 'warn' : 'outline';
  return (
    <Badge tone={tone} className={className} title={evidenceHint(kind)}>
      {EVIDENCE_LABEL[kind]}
    </Badge>
  );
}

function evidenceHint(kind: EvidenceKind): string {
  switch (kind) {
    case 'dart':
      return '전자공시(DART) 원문에서 확인된 근거입니다.';
    case 'news':
      return '뉴스 기사에서 확인된 근거입니다.';
    case 'ai':
      return 'AI가 생성한 분석입니다. 오류가 포함될 수 있습니다.';
    case 'none':
      return '근거 자료가 연결되지 않아 신뢰도가 낮습니다.';
  }
}

/**
 * 근거 목록에서 가장 강한 배지를 고른다.
 *
 * `llm` 은 LLM 이 사업 구조로 지목하고 실존이 확인된 종목이다. 이쪽은 evidence 행이
 * 없어서 그냥 두면 **"근거 부족"** 으로 찍히는데, 뜻이 정반대로 읽힌다 —
 * 문자열이 우연히 겹친 종목보다 근거가 강한 쪽이다.
 */
export function strongestEvidenceKind(sourceTypes: string[], llm = false): EvidenceKind {
  if (sourceTypes.includes('dart')) return 'dart';
  if (sourceTypes.length > 0) return 'news';
  if (llm) return 'ai';
  return 'none';
}

export function DirectionBadge({ direction }: { direction: ImpactDirection }) {
  const tone =
    direction === 'positive' ? 'positive' : direction === 'negative' ? 'negative' : 'neutral';
  return <Badge tone={tone}>{IMPACT_DIRECTION_LABELS[direction]}</Badge>;
}

export function EventTypeBadge({ type }: { type: EventType | null }) {
  if (!type) return <Badge tone="neutral">분류 전</Badge>;
  return <Badge tone="outline">{EVENT_TYPE_LABELS[type]}</Badge>;
}

export function StatusBadge({ status }: { status: EventStatus }) {
  const tone =
    status === 'published' ? 'positive' : status === 'rejected' || status === 'failed' ? 'negative' : 'neutral';
  return <Badge tone={tone}>{EVENT_STATUS_LABELS[status]}</Badge>;
}

export function RelationBadge({ relation }: { relation: RelationType }) {
  return (
    <Badge tone={relation === 'thematic' ? 'warn' : 'outline'}>
      {RELATION_TYPE_LABELS[relation]}
    </Badge>
  );
}

export function LevelBadge({ level }: { level: ImpactLevel }) {
  return <Badge tone="neutral">{IMPACT_LEVEL_LABELS[level]}</Badge>;
}

export function HorizonText({ horizon }: { horizon: TimeHorizon }) {
  return <span className="text-xs text-muted">{TIME_HORIZON_LABELS[horizon]}</span>;
}

const DIRECTION_ARROW: Record<VariableDirection, string> = {
  up: '▲',
  down: '▼',
  mixed: '↔',
  unknown: '·',
};

export function VariableDirectionMark({
  direction,
  className,
}: {
  direction: VariableDirection;
  className?: string;
}) {
  const color =
    direction === 'up' ? 'text-positive' : direction === 'down' ? 'text-negative' : 'text-muted';
  return <span className={cn('font-semibold', color, className)}>{DIRECTION_ARROW[direction]}</span>;
}
