/**
 * 이벤트의 전파 경로 추적 표시를 지워, 새 점수 체계로 다시 채점되게 한다.
 *
 *   node scripts/retrace-events.mjs --dry-run
 *   node scripts/retrace-events.mjs --status published --limit 50
 *
 * 왜 필요한가:
 *   0009 에서 관련도 점수에 집중도·업종이 들어갔다. 이미 저장된 event_impacts 는
 *   옛 점수(최대 35점)를 들고 있어서, 화면의 40점 컷이 이 행들에는 안 먹는다
 *   (lib/queries/events.ts 의 isRescored 가 옛 행을 컷에서 면제해 준다).
 *   재추적해야 비로소 전 종목이 같은 기준으로 줄을 선다.
 *
 * 비용:
 *   재추적은 이벤트당 LLM cheap 호출 1회다. traced_at 을 지우기만 하면
 *   전파 경로 cron 이 알아서 집어가지만, 무료 티어 하루 한도에 걸리면 거기서
 *   멈추고 다음 날 이어서 돈다. 급하면 아래를 반복 호출한다:
 *
 *     curl -X POST "$SITE/api/cron/transmission?limit=20" \
 *       -H "Authorization: Bearer $CRON_SECRET"
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// .env.local 을 직접 읽는다. 이 스크립트만 쓰자고 dotenv 를 끌어오지 않는다.
const env = Object.fromEntries(
  readFileSync(join(root, '.env.local'), 'utf8')
    .split('\n')
    .filter((line) => line.trim() && !line.startsWith('#'))
    .map((line) => {
      const at = line.indexOf('=');
      return [line.slice(0, at).trim(), line.slice(at + 1).trim().replace(/^["']|["']$/g, '')];
    }),
);

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const dryRun = args.includes('--dry-run');
const status = flag('status', 'published');
const limit = Number(flag('limit', '0')) || null;

const supabase = createClient(
  env.NEXT_PUBLIC_SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

const { data: targets, error } = await supabase
  .from('events')
  .select('id, title')
  .eq('status', status)
  .not('traced_at', 'is', null)
  .order('published_at', { ascending: false })
  .limit(limit ?? 1000);

if (error) {
  console.error(`이벤트 조회 실패: ${error.message}`);
  process.exit(1);
}

console.log(`재추적 대상: ${targets.length}건 (status=${status})`);
for (const event of targets.slice(0, 5)) console.log(`  · ${event.title.slice(0, 50)}`);
if (targets.length > 5) console.log(`  … 외 ${targets.length - 5}건`);

if (dryRun) {
  console.log('\n[dry-run] 아무것도 바꾸지 않았습니다.');
  process.exit(0);
}

const { error: updateError } = await supabase
  .from('events')
  .update({ traced_at: null })
  .in('id', targets.map((e) => e.id));

if (updateError) {
  console.error(`재추적 표시 실패: ${updateError.message}`);
  process.exit(1);
}

console.log(`\n${targets.length}건의 traced_at 을 비웠습니다.`);
console.log(`전파 경로 cron 이 이벤트당 LLM cheap 1회를 써서 다시 채점합니다.`);
