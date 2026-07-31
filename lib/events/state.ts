import type { EventStatus } from '@/lib/db/enums';

/**
 * 이벤트 상태 머신 (ARCHITECTURE §8).
 *
 * candidate ──analyze──▶ analyzing ──▶ analyzed ──▶ pending_review
 *                            │                          │
 *                            ▼                     approve│reject
 *                         failed                          ▼
 *                      (retry ≤3)              published / rejected
 *                                                    │
 *                                               unpublish
 *                                                    ▼
 *                                             pending_review
 *
 * 상태 전이는 전부 이 순수 함수를 거친다. DB 업데이트 직전에 확인한다.
 */
const TRANSITIONS: Record<EventStatus, readonly EventStatus[]> = {
  candidate: ['analyzing', 'rejected', 'failed'],
  analyzing: ['analyzed', 'failed', 'candidate'],
  analyzed: ['pending_review', 'failed'],
  pending_review: ['published', 'rejected', 'analyzing'],
  published: ['pending_review', 'rejected'],
  rejected: ['pending_review'],
  failed: ['analyzing', 'rejected'],
};

export const MAX_RETRY = 3;

export function canTransition(from: EventStatus, to: EventStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: EventStatus, to: EventStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`허용되지 않은 상태 전이: ${from} → ${to}`);
  }
}

/** 공개 화면에 보여도 되는 상태인가 (I8) */
export function isPublic(status: EventStatus): boolean {
  return status === 'published';
}

/** 자동 재시도 대상인가 */
export function isRetryable(status: EventStatus, retryCount: number): boolean {
  return status === 'failed' && retryCount < MAX_RETRY;
}

/** 분석 큐에 들어갈 수 있는 상태 */
export function isAnalyzable(status: EventStatus, retryCount: number): boolean {
  return status === 'candidate' || isRetryable(status, retryCount);
}

/** 승인 시 함께 채워야 하는 타임스탬프 (DB CHECK 제약과 짝을 이룬다) */
export function publishTimestamps(now = new Date()): {
  status: 'published';
  approved_at: string;
  published_at: string;
  reviewed_at: string;
} {
  const iso = now.toISOString();
  return { status: 'published', approved_at: iso, published_at: iso, reviewed_at: iso };
}
