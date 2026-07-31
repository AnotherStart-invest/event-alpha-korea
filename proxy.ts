import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

/**
 * Next.js 16 에서 middleware 는 proxy 로 이름이 바뀌었다.
 *
 * 역할 두 가지:
 *  1) Supabase 세션 쿠키 갱신 (Server Component 는 쿠키를 쓸 수 없으므로 여기서 한다)
 *  2) /admin 접근 시 로그인 여부 확인
 *
 * ★ 여기서 role 을 확인하더라도 **서버 액션에서 반드시 재검증**한다.
 *   proxy 만 믿으면 액션을 직접 호출당했을 때 뚫린다.
 */
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return response;

  const supabase = createServerClient(url, key, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const pathname = request.nextUrl.pathname;
  const isAdminArea = pathname.startsWith('/admin') && pathname !== '/admin/login';

  if (isAdminArea && !user) {
    const redirect = request.nextUrl.clone();
    redirect.pathname = '/admin/login';
    redirect.searchParams.set('next', pathname);
    return NextResponse.redirect(redirect);
  }

  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|api/cron|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
};
