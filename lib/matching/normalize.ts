/**
 * 검색어 정규화.
 *
 * Python 배치(`python/profile/build.py`)가 `company_exposures.normalized_value` 를
 * 채울 때와 **반드시 같은 규칙**을 쓴다. 어긋나면 정확 일치가 통째로 실패한다.
 */
export function normalizeTerm(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^0-9a-z가-힣]/g, '');
}

/** trigram 검색은 짧은 한글에서 오탐이 심하다. 최소 길이 기준. */
export const MIN_FUZZY_LENGTH = 3;

export function isFuzzySearchable(value: string): boolean {
  return normalizeTerm(value).length >= MIN_FUZZY_LENGTH;
}

/** 빈 문자열·중복 제거 */
export function cleanKeywords(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (!value) continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    const key = normalizeTerm(trimmed);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}
