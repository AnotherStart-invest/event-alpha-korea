/** 화면 표시용 포매터. 서버/클라이언트 시간대 차이를 막기 위해 Asia/Seoul 로 고정한다. */
const DATE_TIME = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const DATE = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return DATE_TIME.format(date);
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return DATE.format(date);
}

export function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return `${value}%`;
}

/* ── 기업 규모 ─────────────────────────────────────────── */

/**
 * 시가총액 규모 구간.
 *
 * 경계는 python/scripts/sync_market_cap.py 의 LARGE·MID 와 **반드시 같아야 한다**.
 * 어긋나면 수집 스크립트의 집계 출력과 화면 배지가 다른 말을 한다.
 */
export const MARKET_CAP_LARGE = 1_000_000_000_000; // 1조
export const MARKET_CAP_MID = 300_000_000_000; // 3천억

export type MarketCapTier = 'large' | 'mid' | 'small' | 'unknown';

export const MARKET_CAP_TIER_LABELS: Record<MarketCapTier, string> = {
  large: '대형주',
  mid: '중형주',
  small: '소형주',
  unknown: '규모 미상',
};

export function marketCapTier(marketCap: number | null | undefined): MarketCapTier {
  if (marketCap === null || marketCap === undefined || marketCap <= 0) return 'unknown';
  if (marketCap >= MARKET_CAP_LARGE) return 'large';
  if (marketCap >= MARKET_CAP_MID) return 'mid';
  return 'small';
}

/**
 * 시가총액을 조·억 단위 한글로 줄여 쓴다. DB 는 원 단위로 들고 있다.
 *
 *   1_534_600_000_000_000 → "1,535조"
 *     620_000_000_000     → "6,200억"
 */
export function formatMarketCap(marketCap: number | null | undefined): string {
  if (marketCap === null || marketCap === undefined || marketCap <= 0) return '—';

  const jo = marketCap / 1_000_000_000_000;
  if (jo >= 1) {
    // 10조 미만은 소수점 한 자리까지 봐야 종목 간 차이가 보인다.
    return `${jo >= 10 ? Math.round(jo).toLocaleString('ko-KR') : jo.toFixed(1)}조`;
  }
  return `${Math.round(marketCap / 100_000_000).toLocaleString('ko-KR')}억`;
}

export function relativeMinutes(value: string | null | undefined): number | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return Math.floor((Date.now() - date.getTime()) / 60000);
}
