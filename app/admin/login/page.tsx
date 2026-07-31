'use client';

import { useState } from 'react';
import { Button, Card, CardContent } from '@/components/ui/primitives';
import { createBrowserSupabase } from '@/lib/db/browser';

export default function AdminLoginPage() {
  const [email, setEmail] = useState('');
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [message, setMessage] = useState('');

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setState('sending');
    try {
      const supabase = createBrowserSupabase();
      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: `${window.location.origin}/admin` },
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

      <p className="mt-4 text-xs text-muted">
        최초 1회는 로그인 후 <code>python -m python.scripts.bootstrap_admin</code> 으로 관리자
        권한을 부여해야 합니다.
      </p>
    </div>
  );
}
