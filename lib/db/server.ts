import 'server-only';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import type { Database } from './types';
import { required } from '@/lib/shared/env';

/**
 * 사용자 세션 기준 클라이언트. RLS 가 그대로 적용된다.
 * Next.js 16 에서 cookies() 는 비동기이므로 이 함수도 async 다.
 */
export async function createServerSupabase() {
  const cookieStore = await cookies();

  return createServerClient<Database>(
    required('NEXT_PUBLIC_SUPABASE_URL'),
    required('NEXT_PUBLIC_SUPABASE_ANON_KEY'),
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options);
            }
          } catch {
            // Server Component 에서 호출된 경우 쓰기가 불가능하다.
            // proxy.ts 가 세션 갱신을 담당하므로 무시해도 안전하다.
          }
        },
      },
    },
  );
}

/** 로그인 사용자와 관리자 여부를 함께 조회한다. */
export async function getSessionUser() {
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: profile } = await supabase
    .from('profiles')
    .select('id, email, role')
    .eq('id', user.id)
    .maybeSingle();

  return {
    id: user.id,
    email: user.email ?? profile?.email ?? '',
    isAdmin: profile?.role === 'admin',
  };
}

/** 관리자가 아니면 예외. 서버 액션 진입부에서 반드시 호출한다. */
export async function requireAdmin() {
  const user = await getSessionUser();
  if (!user?.isAdmin) {
    const { ForbiddenError } = await import('@/lib/shared/errors');
    throw new ForbiddenError('관리자 권한이 필요합니다.');
  }
  return user;
}
