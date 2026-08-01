import { Card, CardContent, SectionTitle } from '@/components/ui/primitives';
import { VariableDirectionMark } from './badges';
import { TIME_HORIZON_LABELS } from '@/lib/db/enums';
import type { EventRequirementRow, EventRow, EventTransmissionStepRow } from '@/lib/db/types';

/**
 * 투자 논리 구성 — "이 사건으로 어떻게 투자 아이디어를 만드는가".
 *
 * 재료는 원래 다 있었는데 화면 맨 아래에 "확인해야 할 숫자 / 가설이 틀리는 조건 /
 * 후속 이벤트" 세 칸으로 흩어져 있었고, **분석이 끝난 이벤트에만** 나왔다.
 * 그래서 어떤 이벤트에는 전파 경로가 있고 어떤 이벤트에는 아예 없었다.
 *
 * 여기서는 하나의 논리 흐름으로 묶는다:
 *   무엇이 변하나(핵심 변수) → 어떻게 번지나(전파 경로) → 무엇을 확인하나 →
 *   언제 틀렸다고 인정하나 → 다음에 무엇을 보나
 *
 * 마지막 두 개가 핵심이다. **반증 조건이 없는 아이디어는 아이디어가 아니다.**
 */
/**
 * 그릴 내용이 있는가.
 *
 * **호출부가 미리 알아야 한다.** 컴포넌트 안에서만 null 을 반환하면 뒤따르는 섹션의
 * 번호가 어긋난다 — 실제로 "01 투자 논리"와 "01 사건 요약"이 겹치고 02 가 비었다.
 */
export function hasThesisContent(
  event: EventRow,
  steps: EventTransmissionStepRow[],
  requirements: EventRequirementRow[],
): boolean {
  return (
    Boolean(event.primary_variable) ||
    steps.length > 0 ||
    requirements.some((r) =>
      ['evidence_to_check', 'invalidation_condition', 'follow_up_event'].includes(
        r.requirement_type,
      ),
    )
  );
}

export function InvestmentThesis({
  event,
  steps,
  requirements,
  index,
}: {
  event: EventRow;
  steps: EventTransmissionStepRow[];
  requirements: EventRequirementRow[];
  index: number;
}) {
  const byType = (type: string) => requirements.filter((r) => r.requirement_type === type);
  const toCheck = byType('evidence_to_check');
  const invalidation = byType('invalidation_condition');
  const followUp = byType('follow_up_event');
  const ordered = [...steps].sort((a, b) => a.step_order - b.step_order);

  if (!hasThesisContent(event, steps, requirements)) return null;

  // 한 줄에 하나씩, 최대 4줄. 펀드매니저는 이 화면을 훑지 정독하지 않는다.
  // 재료가 많으면 각 줄에서 **가장 중요한 하나씩만** 쓰고 나머지는 접는다.
  const chain = ordered.map((s) => s.description).join(' → ');
  const extra = toCheck.length + invalidation.length + followUp.length - 2;

  return (
    <section>
      <SectionTitle index={index} hint="투자 논리">
        한 줄 요약
      </SectionTitle>

      <Card>
        <CardContent className="space-y-1.5 pt-4 text-sm leading-relaxed">
          {event.primary_variable ? (
            <Line label="변수">
              <span className="font-medium">{event.primary_variable}</span>
              <VariableDirectionMark direction={event.variable_direction} className="ml-1" />
              <span className="ml-1.5 text-xs text-muted">
                · {TIME_HORIZON_LABELS[event.time_horizon]}
              </span>
            </Line>
          ) : null}

          {chain ? <Line label="경로">{chain}</Line> : null}

          {toCheck.length > 0 ? (
            <Line label="확인">{toCheck[0].description}</Line>
          ) : null}

          {invalidation.length > 0 ? (
            <Line label="반증" tone="warn">
              {invalidation[0].description}
            </Line>
          ) : null}

          {extra > 0 ? (
            <details className="pt-1">
              <summary className="cursor-pointer text-[11px] text-muted">
                확인 사항·반증 조건·후속 이벤트 {extra}개 더
              </summary>
              <div className="mt-2 space-y-2 border-t border-border pt-2">
                <More title="확인할 것" items={toCheck.slice(1)} />
                <More title="반증 조건" items={invalidation.slice(1)} tone="warn" />
                <More title="후속 이벤트" items={followUp} />
              </div>
            </details>
          ) : null}
        </CardContent>
      </Card>
    </section>
  );
}

function Line({
  label,
  tone,
  children,
}: {
  label: string;
  tone?: 'warn';
  children: React.ReactNode;
}) {
  return (
    <p className="flex gap-2">
      <span
        className={`mt-px shrink-0 text-[11px] font-semibold ${
          tone === 'warn' ? 'text-warn' : 'text-muted-strong'
        }`}
      >
        {label}
      </span>
      <span className="min-w-0">{children}</span>
    </p>
  );
}

function More({
  title,
  items,
  tone,
}: {
  title: string;
  items: Array<{ id: string; description: string }>;
  tone?: 'warn';
}) {
  if (items.length === 0) return null;
  return (
    <div>
      <p className="text-[11px] font-semibold text-muted-strong">{title}</p>
      <ul className="mt-0.5 space-y-0.5">
        {items.map((item) => (
          <li key={item.id} className="flex gap-1.5 text-xs leading-relaxed">
            <span className={tone === 'warn' ? 'text-warn' : 'text-muted'}>·</span>
            <span>{item.description}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
