'use client';

import { createBrowserClient } from '@supabase/ssr';
import type { Database } from './types';

/**
 * 브라우저 클라이언트. anon 키만 사용하며 RLS 로 보호된다.
 * 여기서는 process.env 를 직접 읽는다 (NEXT_PUBLIC_ 만 번들에 인라인됨).
 */
export function createBrowserSupabase() {
  return createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
