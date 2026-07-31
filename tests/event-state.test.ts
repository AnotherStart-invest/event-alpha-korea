import { describe, expect, it } from 'vitest';
import {
  MAX_RETRY,
  assertTransition,
  canTransition,
  isAnalyzable,
  isPublic,
  isRetryable,
  publishTimestamps,
} from '@/lib/events/state';

describe('상태 전이', () => {
  it('정상 경로를 허용한다', () => {
    expect(canTransition('candidate', 'analyzing')).toBe(true);
    expect(canTransition('analyzing', 'analyzed')).toBe(true);
    expect(canTransition('analyzed', 'pending_review')).toBe(true);
    expect(canTransition('pending_review', 'published')).toBe(true);
  });

  it('검수를 건너뛴 공개를 막는다', () => {
    expect(canTransition('candidate', 'published')).toBe(false);
    expect(canTransition('analyzing', 'published')).toBe(false);
    expect(canTransition('analyzed', 'published')).toBe(false);
  });

  it('공개 취소와 반려를 허용한다', () => {
    expect(canTransition('published', 'pending_review')).toBe(true);
    expect(canTransition('pending_review', 'rejected')).toBe(true);
  });

  it('재분석 경로를 허용한다', () => {
    expect(canTransition('pending_review', 'analyzing')).toBe(true);
    expect(canTransition('failed', 'analyzing')).toBe(true);
  });

  it('허용되지 않는 전이는 예외를 던진다', () => {
    expect(() => assertTransition('candidate', 'published')).toThrow(/허용되지 않은/);
    expect(() => assertTransition('candidate', 'analyzing')).not.toThrow();
  });
});

describe('공개 가능 여부 (I8)', () => {
  it('published 만 공개된다', () => {
    expect(isPublic('published')).toBe(true);
    for (const status of ['candidate', 'analyzing', 'analyzed', 'pending_review', 'rejected', 'failed'] as const) {
      expect(isPublic(status)).toBe(false);
    }
  });
});

describe('재시도', () => {
  it('재시도 한도 내에서만 재시도한다', () => {
    expect(isRetryable('failed', 0)).toBe(true);
    expect(isRetryable('failed', MAX_RETRY - 1)).toBe(true);
    expect(isRetryable('failed', MAX_RETRY)).toBe(false);
  });

  it('실패가 아닌 상태는 재시도 대상이 아니다', () => {
    expect(isRetryable('pending_review', 0)).toBe(false);
  });

  it('분석 큐에는 candidate 와 재시도 가능한 failed 만 들어간다', () => {
    expect(isAnalyzable('candidate', 0)).toBe(true);
    expect(isAnalyzable('failed', 1)).toBe(true);
    expect(isAnalyzable('failed', MAX_RETRY)).toBe(false);
    expect(isAnalyzable('published', 0)).toBe(false);
  });
});

describe('publishTimestamps', () => {
  it('DB CHECK 제약이 요구하는 타임스탬프를 전부 채운다', () => {
    const now = new Date('2026-07-31T05:00:00Z');
    const fields = publishTimestamps(now);
    expect(fields.status).toBe('published');
    expect(fields.approved_at).toBe(now.toISOString());
    expect(fields.published_at).toBe(now.toISOString());
    expect(fields.reviewed_at).toBe(now.toISOString());
  });
});
