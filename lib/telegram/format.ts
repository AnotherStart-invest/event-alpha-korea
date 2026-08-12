import { EVENT_TYPE_LABELS, TIME_HORIZON_LABELS } from '@/lib/db/enums';
import type { EventRequirementRow, EventRow, EventTransmissionStepRow } from '@/lib/db/types';

/**
 * 텔레그램 게시글 포매터.
 *
 * 설계 원칙 하나: **글 하나만 읽어도 값이 있어야 한다.**
 * "자세한 건 링크에서" 식으로 비워 두면 아무도 안 누른다. 사건·경로·종목·확인할 것을
 * 다 넣고, 링크는 "근거와 전체 경로" 를 보러 가는 곳으로 둔다.
 *
 * 그리고 **틀린 것을 안 쓰는 게 더 중요하다.** 채널은 사이트보다 정정이 어렵다.
 * 종목은 원문 직접 언급·AI 사업구조 판단만 싣는다(키워드 매칭은 제외).
 * 그 판단은 호출부(lib/events/broadcast.ts)가 하고 여기는 받은 것만 그린다.
 */

/** 텔레그램 HTML 파스 모드에서 escape 가 필요한 문자. */
function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export type BroadcastCompany = {
  name: string;
  stockCode: string | null;
  /** 이 종목이 왜 관련되는가. 한 문장. */
  reason: string | null;
  direction: 'positive' | 'negative' | 'mixed' | 'uncertain';
};

export type BroadcastInput = {
  event: Pick<
    EventRow,
    'id' | 'title' | 'event_type' | 'primary_variable' | 'variable_direction' | 'time_horizon'
  >;
  steps: Pick<EventTransmissionStepRow, 'step_order' | 'description'>[];
  requirements: Pick<EventRequirementRow, 'requirement_type' | 'description'>[];
  companies: BroadcastCompany[];
  siteUrl: string;
};

/** 한 글에 실을 종목 수. 화면과 같은 원칙 — 나열보다 선별이다. */
export const MAX_COMPANIES = 5;
/** 텔레그램 메시지 상한은 4,096자다. 여유를 두고 자른다. */
const MAX_LENGTH = 3_500;

const ARROW: Record<string, string> = { up: '▲', down: '▼', mixed: '↔', unknown: '' };

export function formatBroadcast(input: BroadcastInput): string {
  const { event, steps, requirements, companies, siteUrl } = input;
  const lines: string[] = [];

  // ── 제목 ────────────────────────────────────────────────
  lines.push(`<b>${esc(event.title)}</b>`);

  const tags = [
    event.event_type ? EVENT_TYPE_LABELS[event.event_type] : null,
    TIME_HORIZON_LABELS[event.time_horizon],
  ].filter(Boolean);
  if (tags.length > 0) lines.push(`<i>${esc(tags.join(' · '))}</i>`);

  // ── 무엇이 변하나 ────────────────────────────────────────
  if (event.primary_variable) {
    const arrow = ARROW[event.variable_direction] ?? '';
    lines.push('', `📌 ${esc(event.primary_variable)} ${arrow}`.trim());
  }

  // ── 어떻게 번지나 ────────────────────────────────────────
  const ordered = [...steps].sort((a, b) => a.step_order - b.step_order);
  if (ordered.length > 0) {
    lines.push('');
    for (const step of ordered) {
      lines.push(`${circled(step.step_order)} ${esc(step.description)}`);
    }
  }

  // ── 관련 종목 ────────────────────────────────────────────
  const positive = companies.filter((c) => c.direction === 'positive').slice(0, MAX_COMPANIES);
  const negative = companies.filter((c) => c.direction === 'negative').slice(0, MAX_COMPANIES);
  const rest = companies
    .filter((c) => c.direction !== 'positive' && c.direction !== 'negative')
    .slice(0, MAX_COMPANIES);

  if (positive.length > 0) lines.push('', `📈 <b>수혜 가능</b>  ${names(positive)}`);
  if (negative.length > 0) lines.push('', `📉 <b>부담 가능</b>  ${names(negative)}`);
  if (positive.length === 0 && negative.length === 0 && rest.length > 0) {
    lines.push('', `🔗 <b>관련</b>  ${names(rest)}`);
  }

  // 종목 하나만 실을 때는 이유까지 붙인다. 여러 개면 길어져서 링크로 넘긴다.
  const only = [...positive, ...negative, ...rest];
  if (only.length === 1 && only[0].reason) {
    lines.push(`<i>${esc(trim(only[0].reason, 140))}</i>`);
  }

  // ── 확인할 것 / 반증 ─────────────────────────────────────
  const toCheck = requirements.find((r) => r.requirement_type === 'evidence_to_check');
  const invalid = requirements.find((r) => r.requirement_type === 'invalidation_condition');
  if (toCheck) lines.push('', `✅ 확인할 것 — ${esc(trim(toCheck.description, 90))}`);
  if (invalid) lines.push(`⚠️ 반증 조건 — ${esc(trim(invalid.description, 90))}`);

  // ── 링크 ────────────────────────────────────────────────
  lines.push('', `<a href="${siteUrl}/events/${event.id}">근거와 전체 전파 경로 보기 →</a>`);
  lines.push(`<i>투자 권유가 아닙니다. 매수·매도·목표가를 제공하지 않습니다.</i>`);

  return clamp(lines.join('\n'));
}

function names(companies: BroadcastCompany[]): string {
  return companies.map((c) => esc(c.name)).join(' · ');
}

function circled(n: number): string {
  const marks = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨'];
  return marks[n - 1] ?? `${n}.`;
}

function trim(text: string, max: number): string {
  const clean = text.trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

/**
 * 텔레그램 상한을 넘지 않게 자른다.
 *
 * ⚠️ **태그 중간에서 자르면 메시지 전송이 통째로 실패한다**(HTML 파스 오류).
 * 그래서 줄 단위로 떼어 내고, 마지막에 링크 줄을 다시 붙인다 — 링크가 이 글의 목적이다.
 */
function clamp(text: string): string {
  if (text.length <= MAX_LENGTH) return text;
  const lines = text.split('\n');
  const tail = lines.slice(-2); // 링크 + 고지문
  const head: string[] = [];
  let size = tail.join('\n').length + 2;
  for (const line of lines.slice(0, -2)) {
    if (size + line.length + 1 > MAX_LENGTH) break;
    head.push(line);
    size += line.length + 1;
  }
  return [...head, '', ...tail].join('\n');
}
