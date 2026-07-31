/**
 * 구조화 로그. Vercel 로그는 휘발되므로 중요한 실패는 DB(pipeline_runs)에도 남긴다.
 * 여기서는 한 줄 JSON만 담당한다.
 */
type Level = 'debug' | 'info' | 'warn' | 'error';

export type LogFields = Record<string, string | number | boolean | null | undefined>;

function emit(level: Level, job: string, message: string, fields?: LogFields) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    job,
    message,
    ...fields,
  });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export function createLogger(job: string) {
  return {
    debug: (message: string, fields?: LogFields) => emit('debug', job, message, fields),
    info: (message: string, fields?: LogFields) => emit('info', job, message, fields),
    warn: (message: string, fields?: LogFields) => emit('warn', job, message, fields),
    error: (message: string, fields?: LogFields) => emit('error', job, message, fields),
    /** 소요 시간을 자동으로 붙여주는 구간 측정 */
    async span<T>(stage: string, fn: () => Promise<T>, fields?: LogFields): Promise<T> {
      const started = Date.now();
      try {
        const result = await fn();
        emit('info', job, stage, { ...fields, ms: Date.now() - started, ok: true });
        return result;
      } catch (err) {
        emit('error', job, stage, {
          ...fields,
          ms: Date.now() - started,
          ok: false,
          err: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    },
  };
}

export type Logger = ReturnType<typeof createLogger>;
