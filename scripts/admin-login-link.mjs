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
// 인자로 주소를 넘길 수 있다: node scripts/admin-login-link.mjs [이메일] [리다이렉트]
const redirectTo = process.argv[3] ?? 'https://eventalpha.org/admin';

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
//
// ⚠️ redirect_to 는 **최상위**여야 한다. options 안에 넣으면 GoTrue 가 조용히 무시하고
// Site URL 로 되돌린다. 오류도 안 난다. 이걸 "리다이렉트 허용 목록이 잘못됐다"로
// 오진하기 쉬우니 주의할 것 — 실제로 그렇게 오진했었다.
const gen = await fetch(`${url}/auth/v1/admin/generate_link`, {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ type: 'magiclink', email, redirect_to: redirectTo }),
});
const body = await gen.text();
if (!gen.ok) {
  console.error('링크 생성 실패:', gen.status, body.slice(0, 400));
  process.exit(1);
}

const result = JSON.parse(body);

// Supabase 가 준 action_link 를 그대로 쓰면 안 된다.
//
// 그 링크는 `/auth/v1/verify` 를 거쳐 토큰을 **URL 해시**(`#access_token=…`)로 돌려주는데,
// 해시는 브라우저에만 남고 서버로 가지 않는다. `/admin` 은 서버에서 쿠키로 세션을
// 확인하므로(app/admin/layout.tsx) 해시를 못 보고 로그인 화면으로 되튕긴다.
// 실제로 "링크를 눌러도 로그인이 안 된다"로 한참 헤맸다.
//
// 대신 hashed_token 을 우리 콜백(app/auth/confirm/route.ts)에 넘긴다.
// Route Handler 는 쿠키를 쓸 수 있으므로 거기서 서버 세션이 확정된다.
const origin = new URL(redirectTo).origin;
const next = new URL(redirectTo).pathname || '/admin';
const link =
  `${origin}/auth/confirm` +
  `?token_hash=${encodeURIComponent(result.hashed_token)}` +
  `&type=${encodeURIComponent(result.verification_type ?? 'magiclink')}` +
  `&next=${encodeURIComponent(next)}`;

console.log('\n아래 링크를 브라우저에 붙여넣으면 로그인됩니다 (1시간 내 1회용):\n');
console.log(link);
