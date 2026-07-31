import Link from 'next/link';
import { getSessionUser } from '@/lib/db/server';
import { Badge } from '@/components/ui/primitives';

export const dynamic = 'force-dynamic';

const NAV = [
  { href: '/admin', label: '대시보드' },
  { href: '/admin/events', label: '이벤트 검수' },
  { href: '/admin/companies', label: '기업 프로필' },
];

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser().catch(() => null);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border pb-3">
        <span className="text-sm font-bold tracking-tight">관리자</span>
        <nav className="flex items-center gap-3 text-sm">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="text-muted-strong transition-colors hover:text-foreground"
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2 text-xs">
          {user ? (
            <>
              <span className="text-muted">{user.email}</span>
              <Badge tone={user.isAdmin ? 'positive' : 'warn'}>
                {user.isAdmin ? 'admin' : '권한 없음'}
              </Badge>
            </>
          ) : (
            <Link href="/admin/login" className="text-accent hover:underline underline-offset-4">
              로그인
            </Link>
          )}
        </div>
      </div>

      {user && !user.isAdmin ? (
        <div className="rounded-lg border border-warn/30 bg-warn-bg p-4 text-sm text-warn">
          <p className="font-medium">관리자 권한이 없습니다.</p>
          <p className="mt-1 text-xs">
            <code>python -m python.scripts.bootstrap_admin</code> 을 실행해 ADMIN_EMAIL 계정을
            승격하세요.
          </p>
        </div>
      ) : (
        children
      )}
    </div>
  );
}
