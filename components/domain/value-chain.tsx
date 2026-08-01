import { Badge } from '@/components/ui/primitives';
import { CompanyChip } from './company-chip';
import { IMPACT_DIRECTION_LABELS } from '@/lib/db/enums';
import type { ChainPosition } from '@/lib/db/types';
import type { ChainLane, ValueChain } from '@/lib/queries/events';

/**
 * 전파 단계를 축으로 종목을 배열한 밸류체인.
 *
 * 이 화면이 생기기 전에는 단계 정보(505건이 쌓여 있었다)를 통째로 버리고 종목을
 * 관련도 순 한 표로 평평하게 늘어놨다. 투자자 입장에서 "무엇이 어디로 전이되는가"가
 * 사라지고 이름 목록만 남았던 이유다.
 *
 * 단계는 사건에서 멀어지는 순서로 생성되므로 그 순서가 곧 상류→하류다.
 */
const POSITION_LABEL: Record<ChainPosition, string> = {
  upstream: '상류',
  midstream: '중간',
  downstream: '하류 · 전방수요',
};

export function ValueChainView({ chain }: { chain: ValueChain }) {
  return (
    <div className="space-y-0">
      {chain.lanes.map((lane, index) => (
        <Lane key={lane.step.id} lane={lane} isLast={index === chain.lanes.length - 1} />
      ))}
    </div>
  );
}

function Lane({ lane, isLast }: { lane: ChainLane; isLast: boolean }) {
  const { step } = lane;
  const tone =
    step.direction === 'positive' ? 'positive' : step.direction === 'negative' ? 'negative' : 'neutral';

  return (
    <div className="flex gap-3">
      {/* 왼쪽 축 — 단계 번호와 연결선 */}
      <div className="flex flex-col items-center">
        <span className="tnum flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-border-strong bg-surface text-[11px] font-semibold">
          {step.step_order}
        </span>
        {!isLast ? <span className="w-px flex-1 bg-border" /> : null}
      </div>

      <div className="min-w-0 flex-1 pb-6">
        <div className="flex flex-wrap items-center gap-1.5">
          {step.chain_position ? (
            <Badge tone="outline">{POSITION_LABEL[step.chain_position]}</Badge>
          ) : null}
          {step.direction && step.direction !== 'uncertain' ? (
            <Badge tone={tone}>{IMPACT_DIRECTION_LABELS[step.direction]}</Badge>
          ) : null}
        </div>

        <p className="mt-1.5 text-sm font-medium leading-relaxed">{step.description}</p>
        {step.reason ? (
          <p className="mt-1 text-xs leading-relaxed text-muted">{step.reason}</p>
        ) : null}

        {lane.shown.length > 0 ? (
          <ul className="mt-2.5 space-y-1.5">
            {lane.shown.map((impact) => (
              <CompanyChip key={impact.id} impact={impact} />
            ))}
          </ul>
        ) : (
          <p className="mt-2.5 rounded-md border border-dashed border-border px-3 py-3 text-xs text-muted">
            이 단계에서 근거가 확인된 상장사가 없습니다.
          </p>
        )}

        {lane.hiddenCount > 0 ? (
          <p className="mt-1.5 text-[11px] text-muted">
            근거가 약해 제외한 종목 {lane.hiddenCount}개
          </p>
        ) : null}
      </div>
    </div>
  );
}
