/**
 * 금융 규제 리스크 방지용 금지 표현.
 *
 * PRODUCT_SPEC §9. LLM 출력과 관리자 입력 양쪽에 적용한다.
 * 프롬프트 지시만으로는 막을 수 없으므로 코드에서 강제한다.
 */
export const BANNED_PHRASES = [
  '지금 매수',
  '지금 매도',
  '매수 추천',
  '매도 추천',
  '매수추천',
  '매도추천',
  '매수 의견',
  '매도 의견',
  '목표주가',
  '목표 주가',
  '적정주가',
  '적정 주가',
  '적정 매수가',
  '진입가',
  '진입 가격',
  '손절가',
  '수익 보장',
  '수익보장',
  '급등 예상',
  '급등주',
  '반드시 상승',
  '반드시 하락',
  '포트폴리오 비중',
  '비중 확대 추천',
  '비중 축소 추천',
  '맞춤 추천',
  '유망주',
  '강력 추천',
] as const;

export type BannedHit = { phrase: string; index: number };

/** 공백/전각 문자를 정규화해 우회 표기를 어느 정도 흡수한다. */
function normalizeForScan(text: string): string {
  return text
    .replace(/[　﻿]/g, ' ')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

export function findBannedPhrases(text: string | null | undefined): BannedHit[] {
  if (!text) return [];
  const haystack = normalizeForScan(text);
  const hits: BannedHit[] = [];
  for (const phrase of BANNED_PHRASES) {
    const needle = normalizeForScan(phrase);
    const index = haystack.indexOf(needle);
    if (index >= 0) hits.push({ phrase, index });
  }
  return hits;
}

export function containsBannedPhrase(text: string | null | undefined): boolean {
  return findBannedPhrases(text).length > 0;
}

/** 객체 안의 모든 문자열 필드를 재귀적으로 검사한다. */
export function scanObjectForBanned(value: unknown, path = '$'): Array<BannedHit & { path: string }> {
  if (typeof value === 'string') {
    return findBannedPhrases(value).map((h) => ({ ...h, path }));
  }
  if (Array.isArray(value)) {
    return value.flatMap((v, i) => scanObjectForBanned(v, `${path}[${i}]`));
  }
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => scanObjectForBanned(v, `${path}.${k}`));
  }
  return [];
}
