'use client';

import * as Tooltip from '@radix-ui/react-tooltip';
import { MAX_SCORES, relevanceLabel } from '@/lib/matching/scoring';
import type { ScoreBreakdown } from '@/lib/db/types';
import { cn } from '@/lib/shared/cn';

/**
 * 관련도 점수 + 근거 breakdown 툴팁.
 *
 * 제품 원칙상 **점수만 보여주면 안 된다.** 7개 항목이 각각 몇 점인지,
 * 왜 그 점수가 나왔는지를 함께 보여준다 (PRODUCT_SPEC §7).
 */
const ROWS: Array<{ key: keyof typeof MAX_SCORES; label: string }> = [
  { key: 'product', label: '직접 제품 관련성' },
  { key: 'revenue', label: '실제 매출·수주 근거' },
  { key: 'geography', label: '지역 노출' },
  { key: 'supplyChain', label: '고객·공급망' },
  { key: 'disclosure', label: '공식 공시 근거' },
  { key: 'recency', label: '최근성' },
  { key: 'thematic', label: '단순 테마' },
];

function isBreakdown(value: unknown): value is ScoreBreakdown {
  return typeof value === 'object' && value !== null && 'total' in value;
}

export function ScoreCell({
  score,
  breakdown,
}: {
  score: number;
  breakdown: ScoreBreakdown | Record<string, never> | null;
}) {
  const detail = isBreakdown(breakdown) ? breakdown : null;

  const tone =
    score >= 75 ? 'text-foreground' : score >= 40 ? 'text-muted-strong' : 'text-muted';

  const trigger = (
    <span className={cn('tnum inline-flex items-baseline gap-1 font-semibold', tone)}>
      {score}
      <span className="text-[10px] font-normal text-muted">/100</span>
    </span>
  );

  if (!detail) return trigger;

  return (
    <Tooltip.Provider delayDuration={100}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <button type="button" className="cursor-help underline decoration-dotted underline-offset-4">
            {trigger}
          </button>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            side="left"
            sideOffset={6}
            className="z-50 w-72 rounded-lg border border-border bg-background p-3 text-xs shadow-lg"
          >
            <p className="mb-2 font-semibold">{relevanceLabel(score)}</p>
            <table className="w-full">
              <tbody>
                {ROWS.map((row) => (
                  <tr key={row.key}>
                    <td className="py-0.5 text-muted">{row.label}</td>
                    <td className="tnum py-0.5 text-right">
                      {detail[row.key]}
                      <span className="text-muted"> / {MAX_SCORES[row.key]}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {detail.notes.length > 0 ? (
              <ul className="mt-2 space-y-0.5 border-t border-border pt-2 text-muted">
                {detail.notes.map((note, i) => (
                  <li key={i}>· {note}</li>
                ))}
              </ul>
            ) : null}
            <Tooltip.Arrow className="fill-border" />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}
