import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 실시간 시세 프록시.
 *
 *   GET /api/quotes?codes=005930,000660
 *
 * 네이버 polling 엔드포인트를 **서버가 대신 부른다.** 브라우저에서 직접 부르면
 * CORS 로 막히고, 사용자 IP 가 그대로 네이버로 나간다.
 *
 * 인증이 없다 — 공개 시세이고 종목코드 외에는 아무것도 받지 않는다.
 * 대신 코드 개수를 제한해 우리 서버를 남의 크롤러로 쓰지 못하게 한다.
 */

const NAVER_URL = 'https://polling.finance.naver.com/api/realtime/domestic/stock';

/** 한 번에 조회할 수 있는 종목 수. 한 화면에 뜨는 종목이 최대 20 남짓이다. */
const MAX_CODES = 30;

/** 네이버 응답을 이만큼 재사용한다. 화면 폴링 주기보다 짧게 둔다. */
const CACHE_SECONDS = 20;

const STOCK_CODE = /^[0-9]{6}$/;

export type Quote = {
  code: string;
  name: string;
  /** 현재가(원). 장 마감 후에는 종가다. */
  price: number;
  /** 전일 대비 변동폭(원). 하락이면 음수. */
  change: number;
  /** 전일 대비 등락률(%). 하락이면 음수. */
  changePercent: number;
};

export async function GET(request: Request) {
  const raw = new URL(request.url).searchParams.get('codes') ?? '';
  const codes = Array.from(new Set(raw.split(',').map((c) => c.trim())))
    .filter((c) => STOCK_CODE.test(c))
    .slice(0, MAX_CODES);

  if (codes.length === 0) {
    return NextResponse.json({ quotes: [] });
  }

  try {
    const response = await fetch(`${NAVER_URL}/${codes.join(',')}`, {
      headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://finance.naver.com/' },
      next: { revalidate: CACHE_SECONDS },
    });
    if (!response.ok) throw new Error(`네이버 응답 ${response.status}`);

    const payload = (await response.json()) as NaverPayload;
    const quotes = (payload.datas ?? []).map(normalize).filter((q): q is Quote => q !== null);

    return NextResponse.json(
      { quotes },
      { headers: { 'Cache-Control': `public, max-age=${CACHE_SECONDS}` } },
    );
  } catch (err) {
    // 시세는 곁들이는 정보다. 실패해도 화면은 떠야 하므로 빈 배열로 흘린다.
    return NextResponse.json(
      { quotes: [], error: err instanceof Error ? err.message : String(err) },
      { status: 200 },
    );
  }
}

type NaverDatum = {
  itemCode?: string;
  stockName?: string;
  closePrice?: string;
  compareToPreviousClosePrice?: string;
  compareToPreviousPrice?: { name?: string };
  fluctuationsRatio?: string;
};
type NaverPayload = { datas?: NaverDatum[] };

function normalize(datum: NaverDatum): Quote | null {
  const code = datum.itemCode;
  if (!code || !STOCK_CODE.test(code)) return null;

  const price = toNumber(datum.closePrice);
  if (price === null) return null;

  // 네이버는 변동폭을 **부호 없이** 주고 방향을 따로 알려준다.
  // 부호를 안 붙이면 하락이 상승으로 뒤집혀 보인다.
  const falling = datum.compareToPreviousPrice?.name === 'FALLING';
  const sign = falling ? -1 : 1;

  return {
    code,
    name: datum.stockName ?? '',
    price,
    change: (toNumber(datum.compareToPreviousClosePrice) ?? 0) * sign,
    changePercent: (toNumber(datum.fluctuationsRatio) ?? 0) * (falling ? -1 : 1),
  };
}

function toNumber(value: string | undefined): number | null {
  if (!value) return null;
  // "262,500" · "26.81" · "-1.2"
  const parsed = Number(value.replace(/,/g, ''));
  return Number.isFinite(parsed) ? Math.abs(parsed) : null;
}
