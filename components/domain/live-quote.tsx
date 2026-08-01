'use client';

import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { Quote } from '@/app/api/quotes/route';
import { cn } from '@/lib/shared/cn';

/**
 * 종목 옆에 붙는 실시간 시세.
 *
 * 화면에 종목이 20개면 요청도 20번이 되면 안 된다. **페이지에 프로바이더 하나**를 두고
 * 거기서 전 종목을 한 번에 받아 각 칩이 꺼내 쓴다(네이버 엔드포인트가 복수 종목을 받는다).
 *
 * 갱신 주기는 1분이다. 탭이 백그라운드면 멈췄다가 돌아올 때 즉시 한 번 받는다 —
 * 안 그러면 오래 열어둔 탭이 옛날 가격을 계속 보여준다.
 */

const REFRESH_MS = 60_000;

type QuoteState = { quotes: Map<string, Quote>; updatedAt: Date | null };

const QuoteContext = createContext<QuoteState>({ quotes: new Map(), updatedAt: null });

export function LiveQuoteProvider({
  codes,
  children,
}: {
  codes: string[];
  children: React.ReactNode;
}) {
  const [state, setState] = useState<QuoteState>({ quotes: new Map(), updatedAt: null });

  // codes 는 부모가 매 렌더마다 새 배열로 만들 수 있다. 문자열로 굳혀
  // effect 가 무한 재실행되지 않게 한다.
  const key = useMemo(() => Array.from(new Set(codes)).filter(Boolean).sort().join(','), [codes]);

  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!key) return;
    let cancelled = false;

    async function load() {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const response = await fetch(`/api/quotes?codes=${key}`, { signal: controller.signal });
        if (!response.ok) return;
        const data = (await response.json()) as { quotes: Quote[] };
        if (cancelled) return;
        setState({
          quotes: new Map(data.quotes.map((q) => [q.code, q])),
          updatedAt: new Date(),
        });
      } catch {
        // 시세는 곁들이는 정보다. 실패하면 직전 값을 그대로 둔다.
      }
    }

    load();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') load();
    }, REFRESH_MS);

    // 탭으로 돌아오면 기다리지 않고 바로 새로 받는다.
    const onVisible = () => {
      if (document.visibilityState === 'visible') load();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      abortRef.current?.abort();
    };
  }, [key]);

  return <QuoteContext.Provider value={state}>{children}</QuoteContext.Provider>;
}

/** 현재가와 등락률. 시세를 못 받았으면 아무것도 그리지 않는다. */
export function LiveQuote({ code, className }: { code: string | null; className?: string }) {
  const { quotes } = useContext(QuoteContext);
  if (!code) return null;

  const quote = quotes.get(code);
  if (!quote) return null;

  const up = quote.changePercent > 0;
  const down = quote.changePercent < 0;
  // 국내 관행대로 **상승이 빨강, 하락이 파랑**이다. 토큰 이름(negative=빨강)과
  // 의미가 어긋나 보이지만, 여기서 초록/빨강을 쓰면 한국 사용자가 반대로 읽는다.
  const color = up ? 'text-negative' : down ? 'text-accent' : 'text-muted';

  return (
    <span className={cn('tnum inline-flex items-baseline gap-1 whitespace-nowrap', className)}>
      <span className="font-semibold">{quote.price.toLocaleString('ko-KR')}</span>
      <span className={cn('font-medium', color)}>
        {up ? '▲' : down ? '▼' : '−'}
        {Math.abs(quote.changePercent).toFixed(2)}%
      </span>
    </span>
  );
}

/** 마지막 갱신 시각. 값이 언제 것인지 안 보이면 실시간인지 알 수 없다. */
export function LiveQuoteStamp({ className }: { className?: string }) {
  const { updatedAt } = useContext(QuoteContext);
  if (!updatedAt) return null;
  return (
    <span className={cn('tnum text-[11px] text-muted', className)}>
      시세 {updatedAt.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })} 기준 ·
      1분마다 갱신
    </span>
  );
}
