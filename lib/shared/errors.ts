export class AppError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean = false,
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

/** 외부 API가 429/5xx 를 반환 — 백오프 후 재시도 가능 */
export class UpstreamError extends AppError {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message, 'UPSTREAM_ERROR', status === 429 || status >= 500);
  }
}

/** LLM 응답이 스키마를 만족하지 못함 */
export class SchemaViolationError extends AppError {
  constructor(message: string, readonly detail?: string) {
    super(message, 'SCHEMA_VIOLATION', true);
  }
}

/** 일일 LLM 예산 초과 — 재시도해도 소용없음. 파이프라인 정지 */
export class BudgetExceededError extends AppError {
  constructor(readonly spentUsd: number, readonly limitUsd: number) {
    super(
      `일일 LLM 예산 초과: $${spentUsd.toFixed(4)} / $${limitUsd.toFixed(2)}`,
      'BUDGET_EXCEEDED',
      false,
    );
  }
}

/** 금지 표현이 산출물에 포함됨 */
export class BannedPhraseError extends AppError {
  constructor(readonly phrases: string[], readonly where: string) {
    super(`금지 표현 검출 (${where}): ${phrases.join(', ')}`, 'BANNED_PHRASE', true);
  }
}

export class ConfigError extends AppError {
  constructor(message: string) {
    super(message, 'CONFIG_ERROR', false);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = '권한이 없습니다.') {
    super(message, 'FORBIDDEN', false);
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * 지수 백오프 재시도. retryable 한 오류에만 적용한다.
 * 기본: 1s → 4s → 16s
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { attempts?: number; baseMs?: number; onRetry?: (attempt: number, err: unknown) => void } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const baseMs = opts.baseMs ?? 1000;
  let lastErr: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const retryable = err instanceof AppError ? err.retryable : true;
      if (!retryable || attempt === attempts) throw err;
      opts.onRetry?.(attempt, err);
      await new Promise((r) => setTimeout(r, baseMs * Math.pow(4, attempt - 1)));
    }
  }
  throw lastErr;
}
