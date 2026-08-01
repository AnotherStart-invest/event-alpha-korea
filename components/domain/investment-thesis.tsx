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

  return (
    <section>
      <SectionTitle index={index} hint="이 사건을 어떻게 투자 논리로 만드는가">
        투자 논리 구성
      </SectionTitle>

      <Card>
        <CardContent className="space-y-4 pt-4">
          {event.primary_variable ? (
            <Row label="① 무엇이 변하나">
              <span className="font-medium">{event.primary_variable}</span>
              <VariableDirectionMark direction={event.variable_direction} className="ml-1" />
              <span className="ml-2 text-xs text-muted">
                영향 기간 {TIME_HORIZON_LABELS[event.time_horizon]}
              </span>
            </Row>
          ) : null}

          {ordered.length > 0 ? (
            <Row label="② 어떻게 번지나">
              <ol className="space-y-1">
                {ordered.map((step) => (
                  <li key={step.id} className="flex gap-2 text-sm leading-relaxed">
                    <span className="tnum shrink-0 text-muted">{step.step_order}.</span>
                    <span>{step.description}</span>
                  </li>
                ))}
              </ol>
            </Row>
          ) : null}

          {toCheck.length > 0 ? (
            <Row label="③ 무엇을 확인하나">
              <p className="mb-1 text-xs text-muted">
                이 숫자들을 직접 보기 전까지는 가설이다. 공시·IR 자료에서 확인한다.
              </p>
              <Bullets items={toCheck} />
            </Row>
          ) : null}

          {invalidation.length > 0 ? (
            <Row label="④ 언제 틀렸다고 인정하나">
              <p className="mb-1 text-xs text-warn">
                하나라도 해당되면 이 논리는 성립하지 않는다.
              </p>
              <Bullets items={invalidation} tone="warn" />
            </Row>
          ) : null}

          {followUp.length > 0 ? (
            <Row label="⑤ 다음에 무엇을 보나">
              <Bullets items={followUp} />
            </Row>
          ) : null}
        </CardContent>
      </Card>
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1 sm:grid-cols-[9rem_1fr] sm:gap-4">
      <p className="text-xs font-semibold text-muted-strong">{label}</p>
      <div className="text-sm">{children}</div>
    </div>
  );
}

function Bullets({
  items,
  tone,
}: {
  items: Array<{ id: string; description: string }>;
  tone?: 'warn';
}) {
  return (
    <ul className="space-y-1">
      {items.map((item) => (
        <li key={item.id} className="flex gap-2 text-sm leading-relaxed">
          <span className={tone === 'warn' ? 'text-warn' : 'text-muted'}>·</span>
          <span>{item.description}</span>
        </li>
      ))}
    </ul>
  );
}
