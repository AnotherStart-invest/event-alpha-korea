import 'server-only';
import { createClient } from '@supabase/supabase-js';
import type { Database } from './types';
import { required } from '@/lib/shared/env';

/**
 * RLS 를 우회하는 service_role 클라이언트.
 *
 * Route Handler(cron) 와 서버 액션에서만 사용한다.
 * `server-only` import 로 클라이언트 번들 유입을 컴파일 타임에 차단한다.
 */
export function createServiceClient() {
  return createClient<Database>(
    required('NEXT_PUBLIC_SUPABASE_URL'),
    required('SUPABASE_SERVICE_ROLE_KEY'),
    {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { 'X-Client-Info': 'event-alpha-korea/service' } },
    },
  );
}

export type ServiceClient = ReturnType<typeof createServiceClient>;
