import { createHash } from 'node:crypto';

/**
 * 뉴스 제목 정규화. 전부 순수 함수이며 단위 테스트 대상이다.
 * 중복 판별 품질이 곧 LLM 비용이므로 여기가 파이프라인에서 가장 중요한 부분 중 하나다.
 */

const ENTITIES: Record<string, string> = {
  '&quot;': '"',
  '&#34;': '"',
  '&apos;': "'",
  '&#39;': "'",
  '&lt;': '<',
  '&gt;': '>',
  '&nbsp;': ' ',
  '&amp;': '&', // 반드시 마지막에 처리
};

/** 네이버 API 는 <b> 태그와 HTML 엔티티를 섞어 보낸다. */
export function stripHtml(input: string): string {
  let out = input.replace(/<[^>]*>/g, '');
  for (const [entity, char] of Object.entries(ENTITIES)) {
    out = out.split(entity).join(char);
  }
  return out.replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)));
}

/** [단독] (종합) 【속보】 <자료> 같은 머리표를 반복 제거한다. */
const BRACKET_PREFIX = /^\s*[[(【<〈{]{1}[^\])】>〉}]{0,20}[\])】>〉}]{1}\s*/;

/** 제목 끝의 "- 매일경제", "| 한국경제" 같은 매체 꼬리표 */
const SOURCE_SUFFIX = /\s*[-–—|·]\s*[가-힣A-Za-z0-9. ]{2,15}(뉴스|일보|경제|신문|타임스|미디어|투데이|넷|TV)\s*$/;

/** 본문 없이 제목에만 붙는 상태 표시 */
const STATUS_WORDS =
  /\s*(?:^|\s)(속보|단독|종합|종합\d보|\d보|영상|포토|사진|인터뷰|기고|칼럼|사설|전문)(?:\s|$)/g;

export function cleanTitle(raw: string): string {
  let title = stripHtml(raw);

  // 머리표는 여러 개 붙을 수 있다: "[단독][영상] 제목"
  let previous: string;
  do {
    previous = title;
    title = title.replace(BRACKET_PREFIX, '');
  } while (title !== previous && title.length > 0);

  title = title.replace(SOURCE_SUFFIX, '');
  title = title.replace(STATUS_WORDS, ' ');

  return title.replace(/\s+/g, ' ').trim();
}

/**
 * 해시용 정규형. 문장부호·공백·대소문자 차이를 전부 흡수한다.
 * 같은 사건을 다룬 같은 제목이 매체별 표기 차이로 갈라지는 것을 막는다.
 */
export function normalizeForHash(cleaned: string): string {
  return cleaned
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^0-9a-z가-힣]/g, '');
}

export function titleHash(rawOrCleaned: string): string {
  return createHash('sha256').update(normalizeForHash(cleanTitle(rawOrCleaned))).digest('hex');
}

/* ── 토큰화 (형태소 분석기 없이) ───────────────────────────── */

/** 조사. 토큰 끝에서만 떼어낸다. 긴 것부터 시도해야 한다. */
const PARTICLES = [
  '으로써', '으로서', '에서는', '에게서', '이라고', '라고는',
  '으로', '에서', '에게', '한테', '까지', '부터', '보다', '처럼', '만큼',
  '이나', '라도', '든지', '이며', '이고', '으며',
  '은', '는', '이', '가', '을', '를', '에', '의', '와', '과', '도', '만', '로', '및',
];

const STOPWORDS = new Set([
  '있다', '없다', '한다', '했다', '된다', '됐다', '하는', '위해', '통해', '대한', '관련',
  '올해', '내년', '작년', '지난', '오늘', '내일', '이번', '최근', '현재',
  '그리고', '하지만', '그러나', '또한', '다시', '모두', '가장', '더욱',
  '기자', '뉴스', '단독', '속보', '종합', '사진', '영상',
]);

function stripParticle(token: string): string {
  if (token.length <= 2) return token;
  for (const particle of PARTICLES) {
    if (token.length > particle.length + 1 && token.endsWith(particle)) {
      return token.slice(0, -particle.length);
    }
  }
  return token;
}

/**
 * 제목에서 비교용 토큰을 뽑는다.
 * 형태소 분석기가 없으므로 공백 분리 + 조사 제거 + 불용어 제거로 근사한다.
 */
export function tokenize(title: string): string[] {
  const cleaned = cleanTitle(title)
    .replace(/[^0-9A-Za-z가-힣\s]/g, ' ')
    .toLowerCase();

  const tokens = cleaned
    .split(/\s+/)
    .map(stripParticle)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));

  return Array.from(new Set(tokens));
}

/** 자카드 유사도. 0~1 */
export function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const token of setA) if (setB.has(token)) intersection++;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** 두 제목이 공유하는 토큰 (클러스터링 조건 판정에 사용) */
export function sharedTokens(a: string, b: string): string[] {
  const tokensB = new Set(tokenize(b));
  return tokenize(a).filter((t) => tokensB.has(t));
}

/** 네이버 pubDate(RFC 1123) → ISO. 파싱 실패 시 null */
export function parsePubDate(value: string): string | null {
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/**
 * 원문 URL 의 호스트에서 언론사를 추정한다.
 * 네이버 검색 API 는 언론사명을 따로 주지 않는다.
 */
export function guessSourceName(originalUrl: string | null | undefined): string | null {
  if (!originalUrl) return null;
  try {
    const host = new URL(originalUrl).hostname.replace(/^www\./, '');
    return host || null;
  } catch {
    return null;
  }
}
