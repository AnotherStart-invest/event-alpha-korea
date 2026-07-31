/**
 * 관리자 로그인 링크를 메일 발송 없이 직접 만든다.
 *
 *   node scripts/admin-login-link.mjs [이메일]
 *
 * Supabase 무료 플랜의 내장 SMTP 는 시간당 2~3통이라 매직링크가 자주 막힌다.
 * Admin API 의 generate_link 는 메일을 보내지 않고 링크만 돌려주므로 한도와 무관하다.
 *
 * service_role 키를 쓰므로 로컬 개발용이다. 절대 브라우저로 나가면 안 된다.
 */
import fs from 'node:fs';

const env = Object.fromEntries(
  fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
);

const email = process.argv[2] ?? env.ADMIN_EMAIL;
const url = env.NEXT_PUBLIC_SUPABASE_URL;
const key = env.SUPABASE_SERVICE_ROLE_KEY;
if (!email) throw new Error('이메일이 없습니다. ADMIN_EMAIL 을 설정하거나 인자로 넘기세요.');

const H = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
const redirectTo = 'http://localhost:3200/admin';

// 1) 계정이 없으면 만든다. email_confirm=true 라 확인 메일이 나가지 않는다.
const created = await fetch(`${url}/auth/v1/admin/users`, {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ email, email_confirm: true }),
});
if (created.ok) {
  console.log('계정 생성됨:', email);
} else {
  const t = await created.text();
  // 이미 있으면 그대로 진행한다.
  console.log('계정 생성 건너뜀:', t.includes('already') || created.status === 422 ? '이미 존재' : t.slice(0, 200));
}

// 2) 메일 없이 로그인 링크만 발급
const gen = await fetch(`${url}/auth/v1/admin/generate_link`, {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ type: 'magiclink', email, options: { redirect_to: redirectTo } }),
});
const body = await gen.text();
if (!gen.ok) {
  console.error('링크 생성 실패:', gen.status, body.slice(0, 400));
  process.exit(1);
}

const link = JSON.parse(body).action_link;
console.log('\n아래 링크를 브라우저에 붙여넣으면 로그인됩니다 (1시간 내 1회용):\n');
console.log(link);
