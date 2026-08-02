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

/**
 * 근거 배지 — **출처 유형**을 말한다.
 *
 * ⚠️ 예전에는 4종(dart/news/ai/none)뿐이라 KRX 상장법인 주요제품 자료가 "기사 확인"
 * 으로 표시됐다. KRX 기업정보는 뉴스가 아니다. 배지가 출처를 잘못 말하면 사용자는
 * 근거의 강도를 잘못 읽는다.
 *
 * 그리고 **근거의 존재와 인과관계의 강도는 다른 것**이다. "공시 확인" 은 그 문장이
 * 공시에 있다는 뜻이지, 이 이벤트로 실적이 움직인다는 뜻이 아니다. 강도는 관련도
 * 점수와 "왜 이 종목인가" 가 따로 말한다.
 */
export type EvidenceKind = 'dart' | 'news' | 'krx' | 'ir' | 'ai' | 'none';

const EVIDENCE_LABEL: Record<EvidenceKind, string> = {
  dart: 'DART 공시',
  news: '원문 뉴스',
  krx: 'KRX 기업정보',
  ir: '회사 IR',
  ai: 'AI 추론',
  none: '추가 확인 필요',
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
      return '전자공시(DART) 원문에 해당 내용이 있습니다. 이 이벤트로 실적이 움직인다는 뜻은 아닙니다.';
    case 'news':
      return '뉴스 기사 원문에서 확인된 근거입니다.';
    case 'krx':
      return 'KRX 상장법인목록의 회사 사업 설명입니다. 기사나 공시가 아닙니다.';
    case 'ir':
      return '회사가 배포한 IR 자료입니다.';
    case 'ai':
      return 'AI 가 사업 구조로 판단했습니다. 공시로 대조한 것은 아닙니다.';
    case 'none':
      return '근거 자료가 연결되지 않았습니다.';
  }
}

/**
 * 근거 목록에서 가장 강한 배지를 고른다.
 *
 * `llm` 은 LLM 이 사업 구조로 지목하고 실존이 확인된 종목이다. evidence 행이 없어서
 * 그냥 두면 "추가 확인 필요" 로 찍히는데 뜻이 정반대로 읽힌다.
 */
export function strongestEvidenceKind(sourceTypes: string[], llm = false): EvidenceKind {
  if (sourceTypes.includes('dart')) return 'dart';
  if (sourceTypes.includes('news')) return 'news';
  if (sourceTypes.includes('company_ir')) return 'ir';
  if (sourceTypes.includes('exchange')) return 'krx';
  if (sourceTypes.length > 0) return 'none';
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
