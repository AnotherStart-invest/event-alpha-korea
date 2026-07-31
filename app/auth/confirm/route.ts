import { redirect } from 'next/navigation';
import type { EmailOtpType } from '@supabase/supabase-js';
import { createServerSupabase } from '@/lib/db/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 매직링크를 **서버 세션(쿠키)** 으로 바꾼다.
 *
 * 이게 없으면 관리자 로그인이 영원히 안 된다. Supabase 의 `/auth/v1/verify` 는
 * 토큰을 URL **해시(`#access_token=…`)** 로 돌려주는데, 해시는 브라우저에만 남고
 * 서버로 전송되지 않는다. `/admin` 은 `app/admin/layout.tsx` 에서 서버 측으로
 * 쿠키를 읽어 세션을 확인하므로, 해시에 뭐가 오든 못 보고 로그인 화면으로 튕긴다.
 * 증상이 "링크를 눌러도 로그인이 안 된다"라 원인을 찾기 어렵다.
 *
 * 그래서 Supabase 의 verify 를 거치지 않고, `generate_link` 가 주는 `hashed_token` 을
 * 우리 서버가 직접 `verifyOtp` 로 교환한다. Route Handler 는 Server Component 와 달리
 * 쿠키를 쓸 수 있으므로 여기서 세션이 확정된다.
 */
const ALLOWED_TYPES: EmailOtpType[] = ['magiclink', 'recovery', 'invite', 'email', 'email_change'];

export async function GET(request: Request) {
  const url = new URL(request.url);
  const tokenHash = url.searchParams.get('token_hash');
  const type = url.searchParams.get('type') as EmailOtpType | null;
  const code = url.searchParams.get('code');
  const next = url.searchParams.get('next') ?? '/admin';

  // 오픈 리다이렉트 방지 — 우리 사이트 안의 경로만 허용한다.
  // `//evil.com` 은 프로토콜 상대 URL 이라 외부로 나가므로 같이 막는다.
  const destination = next.startsWith('/') && !next.startsWith('//') ? next : '/admin';

  const supabase = await createServerSupabase();

  // 경로가 둘이다.
  //  - token_hash: scripts/admin-login-link.mjs 가 admin API 로 뽑은 링크
  //  - code:       로그인 화면의 signInWithOtp 가 보낸 메일 링크(PKCE)
  //                검증자(verifier)는 @supabase/ssr 가 쿠키에 넣어두므로 서버가 읽을 수 있다
  const { error } = code
    ? await supabase.auth.exchangeCodeForSession(code)
    : tokenHash && type && ALLOWED_TYPES.includes(type)
      ? await supabase.auth.verifyOtp({ type, token_hash: tokenHash })
      : { error: { message: '링크가 올바르지 않습니다.' } };

  if (error) {
    // 만료(1시간)·재사용이 대부분이다. 원문을 그대로 보여줘야 재발급 판단이 된다.
    redirect('/admin/login?error=' + encodeURIComponent(error.message));
  }

  redirect(destination);
}
