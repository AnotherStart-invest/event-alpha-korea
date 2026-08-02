'use client';

import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Button, Card, CardContent } from '@/components/ui/primitives';
import { createBrowserSupabase } from '@/lib/db/browser';

export default function AdminLoginPage() {
  // useSearchParams 는 Suspense 경계가 필요하다.
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const [email, setEmail] = useState('');
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [message, setMessage] = useState('');
  // 콜백(app/auth/confirm/route.ts)이 실패하면 사유를 여기로 넘긴다.
  // 안 보여주면 "눌렀는데 그냥 로그인 화면"이 되어 원인을 알 수 없다.
  const callbackError = useSearchParams().get('error');

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setState('sending');
    try {
      const supabase = createBrowserSupabase();
      const { error } = await supabase.auth.signInWithOtp({
        email,
        // /admin 으로 바로 보내면 안 된다. 토큰이 URL 해시로 와서 서버가 못 읽는다.
        // 콜백을 거쳐야 쿠키 세션이 선다.
        options: { emailRedirectTo: `${window.location.origin}/auth/confirm?next=/admin` },
      });
      if (error) throw error;
      setState('sent');
    } catch (err) {
      setState('error');
      setMessage(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="mx-auto max-w-sm py-10">
      <h1 className="text-lg font-bold tracking-tight">관리자 로그인</h1>
      <p className="mt-1 text-sm text-muted">가입된 이메일로 로그인 링크를 보냅니다.</p>

      {callbackError ? (
        <p className="mt-4 rounded-md border border-negative/40 bg-negative/5 px-3 py-2 text-xs text-negative">
          로그인 링크 처리 실패: {callbackError}
        </p>
      ) : null}

      <Card className="mt-5">
        <CardContent className="pt-4">
          {state === 'sent' ? (
            <p className="text-sm">
              <strong>{email}</strong> 으로 로그인 링크를 보냈습니다. 메일함을 확인하세요.
            </p>
          ) : (
            <form onSubmit={submit} className="space-y-3">
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className="h-9 w-full rounded-md border border-border-strong bg-background px-3 text-sm outline-none focus-visible:border-accent"
              />
              <Button type="submit" disabled={state === 'sending'} className="w-full">
                {state === 'sending' ? '전송 중…' : '로그인 링크 받기'}
              </Button>
              {state === 'error' ? <p className="text-xs text-negative">{message}</p> : null}
            </form>
          )}
        </CardContent>
      </Card>


    </div>
  );
}
