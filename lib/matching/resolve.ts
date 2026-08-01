import { COMMON_ALIASES, type MentionCompany, type MentionDict } from './mentions';
import { normalizeTerm } from './normalize';

/**
 * LLM 이 말한 회사 이름을 **실존 상장사로 해석한다.**
 *
 * ── 왜 이게 생겼나 ────────────────────────────────────────────
 * 이 시스템의 원래 불변식은 "LLM 은 기업명을 출력할 수 없다" 였다. 환각 종목을
 * 원천 차단하려는 설계였고 그 자체로는 옳았다. 문제는 그 대가로 **KRX 주요제품
 * 문자열 매칭**이 종목을 찾는 유일한 다리가 됐다는 것이다.
 *
 * 그 다리의 한계가 이 세션 내내 실측으로 드러났다:
 *   - "소프트웨어 개발"(13개사)로 넷마블·셀바스AI·스피어가 같이 걸린다
 *   - 원양어업 회사가 "소프트웨어 개발" 한 줄로 유학생 비자 뉴스에 붙는다
 *   - 밸류체인의 전·후방을 문자열로는 영원히 못 잇는다
 *     (company_exposures 의 고객사 20건 / 공급사 11건이 전부다)
 *
 * ── 바뀐 불변식 ──────────────────────────────────────────────
 * "LLM 은 기업명을 **제안**할 수 있다. 다만 코드가 실존을 검증한다."
 *
 * LLM 이 아무 이름이나 말해도, 여기서 상장사 사전에 해석되지 않으면 버려진다.
 * 그래서 **없는 종목이 화면에 뜨는 일은 여전히 불가능하다.** 달라진 것은
 * 후보를 만드는 방법뿐이고, 검증 지점은 그대로다.
 */

export type ResolvedCompany = {
  company: MentionCompany;
  /** LLM 이 쓴 원래 표기. 로그와 검수에서 무엇이 어떻게 해석됐는지 보려면 필요하다. */
  proposedName: string;
};

export type ResolveResult = {
  resolved: ResolvedCompany[];
  /** 사전에 없어 버린 이름. 프롬프트가 헛돌고 있는지 보는 지표다. */
  unresolved: string[];
};

/**
 * 이름 목록을 상장사로 해석한다. 중복은 접는다.
 *
 * 해석 순서:
 *   1. 손으로 검증한 약칭 사전(현대차 → 005380)
 *   2. 정규화된 정식명칭
 *   3. 접미어를 뗀 형태 — LLM 이 "삼성전자㈜", "LG화학 주식회사" 처럼 쓸 때가 있다
 */
export function resolveCompanyNames(dict: MentionDict, names: string[]): ResolveResult {
  const resolved: ResolvedCompany[] = [];
  const unresolved: string[] = [];
  const seen = new Set<string>();

  const byCode = new Map<string, MentionCompany>();
  for (const company of dict.byKey.values()) byCode.set(company.stockCode, company);

  for (const raw of names) {
    const name = raw.trim();
    if (!name) continue;

    const company = lookup(dict, byCode, name);
    if (!company) {
      unresolved.push(name);
      continue;
    }
    if (seen.has(company.companyId)) continue;
    seen.add(company.companyId);
    resolved.push({ company, proposedName: name });
  }

  return { resolved, unresolved };
}

function lookup(
  dict: MentionDict,
  byCode: Map<string, MentionCompany>,
  name: string,
): MentionCompany | null {
  // 1) 약칭 사전 — 값이 종목코드다
  const aliasCode = COMMON_ALIASES[name] ?? COMMON_ALIASES[name.replace(/\s+/g, '')];
  if (aliasCode) {
    const viaAlias = byCode.get(aliasCode);
    if (viaAlias) return viaAlias;
  }

  // 2) 정식명칭
  const exact = dict.byKey.get(normalizeTerm(name));
  if (exact) return exact;

  // 3) 법인 접미어 제거 후 재시도
  const stripped = stripCorporateSuffix(name);
  if (stripped !== name) {
    const viaStripped = dict.byKey.get(normalizeTerm(stripped));
    if (viaStripped) return viaStripped;
  }

  return null;
}

/**
 * "㈜", "주식회사", "(주)" 같은 법인 표기를 뗀다.
 *
 * **부분 일치로 넓히지 않는다.** "한국전력기술" 을 "한국전력" 으로 해석하면
 * 완전히 다른 회사가 된다. 접미어 제거는 표기 차이만 흡수하고, 그래도 안 맞으면
 * 버리는 편이 안전하다.
 */
function stripCorporateSuffix(name: string): string {
  return name
    .replace(/\(주\)|\(株\)|㈜|주식회사/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
