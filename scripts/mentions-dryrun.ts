/**
 * 직접 언급 매칭을 DB 에 쓰지 않고 미리 돌려본다.
 *
 *   npx tsx scripts/mentions-dryrun.ts
 *
 * 상장사 사전은 KRX 에서 바로 받는다(마이그레이션 적용 전에도 돌아가도록).
 * 기사는 Supabase 의 news_articles 를 읽는다.
 *
 * 매칭 규칙을 손볼 때마다 이걸 돌려 오탐이 늘지 않았는지 눈으로 확인할 것.
 */
import { readFileSync } from 'node:fs';
import { buildMentionDict, findMentions, type MentionCompany } from '../lib/matching/mentions';

const KRX_URL = 'https://kind.krx.co.kr/corpgeneral/corpList.do?method=download&searchType=13';

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.includes('=') && !line.startsWith('#'))
    .map((line) => {
      const i = line.indexOf('=');
      return [line.slice(0, i).trim(), line.slice(i + 1).trim()];
    }),
);

async function loadCompanies(): Promise<MentionCompany[]> {
  const response = await fetch(KRX_URL);
  const html = new TextDecoder('euc-kr').decode(await response.arrayBuffer());

  const companies: MentionCompany[] = [];
  for (const [, row] of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const cells = [...row.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map(([, cell]) =>
      cell.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').trim(),
    );
    if (cells.length < 5 || !/^[0-9]{6}$/.test(cells[2])) continue;
    companies.push({
      companyId: cells[2],
      companyName: cells[0],
      stockCode: cells[2],
      market: cells[1],
      industryName: cells[3] || null,
      latestReportDate: null,
    });
  }
  return companies;
}

async function loadArticles() {
  const url = `${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/news_articles?select=title,description&limit=200`;
  const response = await fetch(url, {
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  return (await response.json()) as Array<{ title: string; description: string | null }>;
}

async function main() {
  const companies = await loadCompanies();
  const dict = buildMentionDict(companies);
  const articles = await loadArticles();

  console.log(`상장사 ${companies.length}건 → 사전 ${dict.byKey.size}개 표기`);
  console.log(`기사 ${articles.length}건\n`);

  let matchedArticles = 0;
  let totalMentions = 0;
  const frequency = new Map<string, number>();

  for (const article of articles) {
    const mentions = findMentions(dict, article);
    if (mentions.length === 0) continue;
    matchedArticles++;
    totalMentions += mentions.length;
    for (const mention of mentions) {
      frequency.set(mention.company.companyName, (frequency.get(mention.company.companyName) ?? 0) + 1);
    }
    if (matchedArticles <= 25) {
      console.log(`· ${article.title.slice(0, 60)}`);
      for (const mention of mentions) {
        console.log(
          `    → ${mention.company.companyName} (${mention.company.stockCode})` +
            ` ${mention.inTitle ? '제목' : '본문'} · "${mention.matchedText}"`,
        );
      }
    }
  }

  console.log(
    `\n기사 ${matchedArticles}/${articles.length}건에서 언급 발견` +
      ` (${Math.round((matchedArticles / articles.length) * 100)}%), 총 ${totalMentions}건`,
  );
  console.log('\n자주 나온 종목:');
  for (const [name, count] of [...frequency].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
    console.log(`  ${count}회  ${name}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
