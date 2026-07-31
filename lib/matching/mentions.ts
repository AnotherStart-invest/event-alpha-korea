/**
 * 기사 본문에 **직접 이름이 나온** 상장사를 찾아낸다.
 *
 * 왜 필요한가:
 * 후보 생성(candidates.ts)은 company_exposures 만 뒤진다. 그런데 그 테이블을 채우는
 * build_profiles 는 기업당 LLM 5회를 쓰므로 무료 티어에서는 사실상 채울 수 없다.
 * 반면 기사는 이미 "삼성SDI", "HL만도" 처럼 종목명을 직접 말하고 있다.
 * 그걸 읽는 데는 토큰이 한 개도 들지 않는다.
 *
 * 원칙은 그대로다 — **LLM 이 개입하지 않는다.** 사전과 문자열 경계 규칙만 쓴다.
 * 지어낼 여지가 없고, 매칭된 자리의 원문 발췌를 근거로 남긴다.
 *
 * 이 파일은 DB 를 모른다. 순수 함수만 두어 테스트로 오탐을 고정한다.
 */
import { normalizeTerm } from './normalize';

export type MentionCompany = {
  companyId: string;
  companyName: string;
  stockCode: string;
  market: string | null;
  industryName: string | null;
  latestReportDate: string | null;
};

export type MentionDict = {
  /** 정규화된 표기 → 기업. 같은 표기가 겹치면(동명이인) 버린다. */
  byKey: Map<string, MentionCompany>;
  maxKeyLength: number;
  minKeyLength: number;
};

export type Mention = {
  company: MentionCompany;
  /** 실제로 매칭된 원문 표기 ("삼성SDI") */
  matchedText: string;
  /** 근거로 남길 원문 발췌 */
  excerpt: string;
  /** 제목에서 발견됐는가. 본문 언급보다 신뢰도가 높다. */
  inTitle: boolean;
};

/**
 * 이보다 짧은 이름은 쓰지 않는다.
 * 상장사 중 2자 이름이 69개나 되는데 "도움", "우방", "대호" 처럼 일반명사가 많아
 * 오탐 비용이 이득보다 크다.
 */
export const MIN_NAME_LENGTH = 3;

/** 발췌 앞뒤로 남길 원문 길이 */
const EXCERPT_PAD = 45;

/**
 * 3자 이상이지만 일반명사로 더 자주 쓰이는 상장사명.
 * 여기 없는 것이 발견되면 추가하고 tests/mentions.test.ts 에 케이스를 남길 것.
 */
export const AMBIGUOUS_NAMES = new Set(
  [
    '한국전자',
    '한국정보',
    '대한제당',
    '이지바이오',
    '우리기술',
    '한국정보통신',
    '아이티엠',
    '에스엠',
    '디지털',
    '네트웍스',
    '홀딩스',
    '커머스',
    '테크놀로지',
  ].map(normalizeTerm),
);

/**
 * 손으로 유지하는 약칭 사전. KRX·DART 정식명칭과 기사 표기가 다른 대형주만 담는다.
 * 값은 종목코드다 — 회사명이 바뀌어도 깨지지 않는다.
 *
 * 자동 생성하지 않는 이유: "현대차 → 현대자동차" 같은 축약 규칙을 일반화하면
 * 반드시 엉뚱한 짝이 생긴다. 수가 적으므로 손으로 두는 편이 안전하다.
 */
export const COMMON_ALIASES: Record<string, string> = {
  현대차: '005380',
  기아차: '000270',
  엘지엔솔: '373220',
  LG엔솔: '373220',
  하이닉스: '000660',
  포스코: '005490',
  한전: '015760',
  한국전력: '015760',
  한국타이어: '161390',
  두산중공업: '034020', // 두산에너빌리티의 옛 이름
  현대중공업: '329180', // HD현대중공업
  삼성바이오: '207940',
  삼성물산: '028260',
  엘지화학: '051910',
  에스케이이노베이션: '096770',
};

/** 약칭은 손으로 검증한 것이므로 자동 유도 이름보다 짧아도 허용한다. */
const MIN_ALIAS_LENGTH = 2;

/**
 * 회사명 뒤에 붙어도 같은 회사를 가리키는 조사.
 * 이게 없으면 "삼성전자가 발표했다" 를 못 잡는다.
 * 반대로 이 목록에 없는 한글이 이어지면("대한 항공사", "현대차그룹") 다른 낱말로 보고 버린다.
 */
const PARTICLES = new Set([
  '가', '이', '은', '는', '을', '를', '의', '에', '와', '과', '도', '만', '로', '으로',
  '에서', '에게', '부터', '까지', '라', '이라', '이나', '나', '고', '며', '이며', '보다',
  '처럼', '만큼', '조차', '마저', '밖에', '으로써', '로써', '으로서', '로서', '한테',
  '이라고', '라고', '이란', '란', '들', '들이', '들은', '들을', '들의', '측', '측은', '측이',
  '와의', '과의', '로의', '으로의', '에서의', '에는', '에도', '에선', '에서는', '와는', '과는',
  '로는', '으로는', '만은', '만이', '부터는', '까지는', '이라는', '라는', '이든', '든', '랑', '이랑',
]);

const WORD_CHAR = /[0-9A-Za-z가-힣]/;
const HANGUL = /[가-힣]/;

/**
 * 증권사는 기사에서 대개 **논평 주체**로 나온다.
 * "SK증권 \"LG전자, 전 사업부 양호\"" 에서 관련 종목은 LG전자지 SK증권이 아니다.
 * 그래서 다른 종목이 같이 잡힌 기사에서는 증권사를 뺀다.
 * 단독으로 나온 경우("SK증권, 유상증자 결의")는 그 회사가 기사의 대상이므로 남긴다.
 */
const COMMENTATOR = /증권$/;

/** 사전을 만든다. 상장 종목만 넘길 것 — 상장폐지 껍데기가 섞이면 오탐이 급증한다. */
export function buildMentionDict(companies: MentionCompany[]): MentionDict {
  const byKey = new Map<string, MentionCompany>();
  const collided = new Set<string>();
  const byStockCode = new Map<string, MentionCompany>();

  const add = (key: string, company: MentionCompany, minLength = MIN_NAME_LENGTH) => {
    if (key.length < minLength || AMBIGUOUS_NAMES.has(key)) return;
    const existing = byKey.get(key);
    if (existing && existing.companyId !== company.companyId) {
      // 같은 표기를 두 회사가 쓰면 어느 쪽인지 알 수 없다. 둘 다 버린다.
      collided.add(key);
      return;
    }
    byKey.set(key, company);
  };

  for (const company of companies) {
    byStockCode.set(company.stockCode, company);
    add(normalizeTerm(company.companyName), company);
  }

  for (const [alias, stockCode] of Object.entries(COMMON_ALIASES)) {
    const company = byStockCode.get(stockCode);
    if (company) add(normalizeTerm(alias), company, MIN_ALIAS_LENGTH);
  }

  for (const key of collided) byKey.delete(key);

  let maxKeyLength = 0;
  let minKeyLength = Number.POSITIVE_INFINITY;
  for (const key of byKey.keys()) {
    maxKeyLength = Math.max(maxKeyLength, key.length);
    minKeyLength = Math.min(minKeyLength, key.length);
  }
  if (byKey.size === 0) minKeyLength = MIN_NAME_LENGTH;

  return { byKey, maxKeyLength, minKeyLength };
}

/**
 * 기사 한 건에서 언급된 상장사를 찾는다.
 *
 * 제목과 본문을 따로 훑어 어디서 나왔는지 구분한다.
 * 같은 회사가 여러 번 나오면 제목 쪽을 남긴다.
 */
export function findMentions(
  dict: MentionDict,
  article: { title: string; description?: string | null },
): Mention[] {
  const found = new Map<string, Mention>();

  for (const [text, inTitle] of [
    [article.title, true],
    [article.description ?? '', false],
  ] as const) {
    for (const hit of scan(dict, text)) {
      const existing = found.get(hit.company.companyId);
      if (existing && (existing.inTitle || !inTitle)) continue;
      found.set(hit.company.companyId, { ...hit, inTitle });
    }
  }

  const mentions = Array.from(found.values());
  const subjects = mentions.filter((m) => !COMMENTATOR.test(m.company.companyName));
  return subjects.length > 0 ? subjects : mentions;
}

/* ── 내부 ─────────────────────────────────────────────── */

type NormalizedText = { norm: string; origin: number[] };

/**
 * 매칭용 정규화. 공백·기호를 **지우고** 원문 위치를 같이 들고 다닌다.
 *
 * 공백을 지우는 이유는 "삼성 SDI" 같은 표기를 잡기 위해서다. 대신 그 부작용으로
 * "대한 항공사" 가 "대한항공" 으로 붙어버리는데, 경계 검사(acceptBoundary)가 막는다.
 * 위치 배열이 없으면 그 검사를 할 수 없으므로 normalizeTerm 을 그냥 쓸 수 없다.
 */
export function normalizeWithOrigin(text: string): NormalizedText {
  const folded = text.normalize('NFKC');
  let norm = '';
  const origin: number[] = [];

  for (let i = 0; i < folded.length; i++) {
    const lowered = folded[i].toLowerCase();
    // NFKC + toLowerCase 가 1:1 이 아닌 경우가 있어 방어적으로 자른다.
    if (lowered.length !== 1) continue;
    if (!WORD_CHAR.test(lowered)) continue;
    norm += lowered;
    origin.push(i);
  }
  return { norm, origin };
}

function* scan(dict: MentionDict, text: string): Generator<Omit<Mention, 'inTitle'>> {
  if (!text) return;
  const folded = text.normalize('NFKC');
  const { norm, origin } = normalizeWithOrigin(text);

  let i = 0;
  while (i < norm.length) {
    // 긴 이름 우선. "한국타이어앤테크놀로지" 가 "한국타이어" 보다 먼저 걸려야 한다.
    const maxLen = Math.min(dict.maxKeyLength, norm.length - i);
    let matched: { company: MentionCompany; length: number } | null = null;

    for (let len = maxLen; len >= dict.minKeyLength; len--) {
      const company = dict.byKey.get(norm.slice(i, i + len));
      if (!company) continue;
      if (!acceptBoundary(folded, origin, i, len)) continue;
      matched = { company, length: len };
      break;
    }

    if (!matched) {
      i++;
      continue;
    }

    const start = origin[i];
    const end = origin[i + matched.length - 1] + 1;
    yield {
      company: matched.company,
      matchedText: folded.slice(start, end),
      excerpt: excerptAround(folded, start, end),
    };

    i += matched.length;
  }
}

/**
 * 원문 기준 경계 검사. 정규화가 지운 공백 때문에 생기는 오탐을 여기서 막는다.
 *
 *   "대한 항공사가 …"  → 뒤에 '사가' 가 붙음 → 조사가 아니므로 버림
 *   "삼성전자가 …"     → 뒤가 조사 '가' → 채택
 *   "현대차그룹"        → 뒤가 '그룹' → 버림 (현대차와 다른 대상)
 */
function acceptBoundary(text: string, origin: number[], i: number, length: number): boolean {
  const start = origin[i];
  const end = origin[i + length - 1] + 1;

  // 앞: 낱말 문자가 붙어 있으면 다른 낱말의 일부다.
  const before = start > 0 ? text[start - 1] : '';
  if (before && WORD_CHAR.test(before)) return false;

  // 뒤: 영문·숫자가 붙으면 다른 낱말.
  const after = text[end] ?? '';
  if (after && WORD_CHAR.test(after) && !HANGUL.test(after)) return false;

  // 뒤: 한글이 이어지면 조사일 때만 허용한다.
  let run = '';
  for (let k = end; k < text.length && HANGUL.test(text[k]); k++) run += text[k];
  if (run === '') return true;
  return PARTICLES.has(run);
}

function excerptAround(text: string, start: number, end: number): string {
  const from = Math.max(0, start - EXCERPT_PAD);
  const to = Math.min(text.length, end + EXCERPT_PAD);
  const slice = text.slice(from, to).replace(/\s+/g, ' ').trim();
  return `${from > 0 ? '…' : ''}${slice}${to < text.length ? '…' : ''}`;
}
