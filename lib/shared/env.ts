import { z } from 'zod';

/**
 * 서버 전용 환경변수. 클라이언트 번들에 들어가면 안 되므로
 * 이 모듈은 절대 'use client' 컴포넌트에서 import 하지 않는다.
 *
 * 값이 없어도 모듈 로드 자체는 실패시키지 않는다. (빌드 타임에 일부 키가
 * 비어 있을 수 있음) 대신 실제로 필요한 시점에 requireXxx()로 확인한다.
 */
const serverSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url().optional(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),

  NAVER_CLIENT_ID: z.string().optional(),
  NAVER_CLIENT_SECRET: z.string().optional(),

  OPENDART_API_KEY: z.string().optional(),

  LLM_PROVIDER: z.enum(['anthropic', 'openai', 'gemini']).default('anthropic'),
  OPENAI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  // AI Studio 키. 무료 티어라 카드 등록이 필요 없다.
  GEMINI_API_KEY: z.string().optional(),

  CRON_SECRET: z.string().optional(),
  ADMIN_EMAIL: z.string().email().optional(),

  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
});

export type ServerEnv = z.infer<typeof serverSchema>;

let cached: ServerEnv | null = null;

export function env(): ServerEnv {
  if (cached) return cached;
  const parsed = serverSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(
      `환경변수 형식 오류:\n${parsed.error.issues
        .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
        .join('\n')}`,
    );
  }
  cached = parsed.data;
  return cached;
}

/** 없으면 명확한 메시지와 함께 즉시 실패시킨다. */
export function required<K extends keyof ServerEnv>(key: K): NonNullable<ServerEnv[K]> {
  const value = env()[key];
  if (value === undefined || value === null || value === '') {
    throw new Error(
      `환경변수 ${key} 가 설정되지 않았습니다. .env.example 을 참고해 .env.local 에 추가하세요.`,
    );
  }
  return value as NonNullable<ServerEnv[K]>;
}

export const isProd = () => env().NODE_ENV === 'production';
export const isDev = () => env().NODE_ENV === 'development';
