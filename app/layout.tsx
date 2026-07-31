import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'Event Alpha Korea',
    template: '%s · Event Alpha Korea',
  },
  description:
    '뉴스에서 투자 관련 이벤트를 추출하고, 경제적 전파 경로를 따라 근거가 있는 국내 상장 종목을 연결하는 리서치 지원 도구.',
  robots: { index: false, follow: false },
};

const NAV = [
  { href: '/events', label: '이벤트' },
  { href: '/companies', label: '기업' },
  { href: '/about', label: '서비스 소개' },
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body className="flex min-h-dvh flex-col bg-background text-foreground">
        <header className="sticky top-0 z-40 border-b border-border bg-background/95 backdrop-blur">
          <div className="mx-auto flex h-14 max-w-6xl items-center gap-6 px-4">
            <Link href="/" className="flex items-baseline gap-2">
              <span className="text-sm font-bold tracking-tight">EVENT ALPHA</span>
              <span className="text-[10px] font-semibold tracking-widest text-muted">KOREA</span>
            </Link>
            <nav className="flex items-center gap-4 text-sm">
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
            <div className="ml-auto">
              <Link
                href="/admin"
                className="text-xs text-muted transition-colors hover:text-foreground"
              >
                관리자
              </Link>
            </div>
          </div>
        </header>

        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6">{children}</main>

        <footer className="mt-12 border-t border-border bg-surface">
          <div className="mx-auto max-w-6xl px-4 py-6">
            <p className="text-xs leading-relaxed text-muted">
              본 서비스는 공개된 뉴스와 전자공시 정보를 자동으로 분석해 제공하는 리서치 지원
              도구입니다. 투자자문·투자권유가 아니며, 특정 종목의 매수·매도를 추천하지 않습니다.
              자동 분석 결과에는 오류가 포함될 수 있으므로 반드시 원문과 공시를 직접 확인하십시오.
              투자 판단과 그 결과에 대한 책임은 이용자 본인에게 있습니다.
            </p>
            <p className="mt-2 text-xs text-muted">
              기사 본문은 저장하지 않으며 제목·요약·출처·링크만 사용합니다.
            </p>
          </div>
        </footer>
      </body>
    </html>
  );
}
