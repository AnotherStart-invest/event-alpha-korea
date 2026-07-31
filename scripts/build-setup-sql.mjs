/**
 * 마이그레이션 3개를 하나로 합쳐 supabase/setup.sql 을 만든다.
 * Supabase SQL Editor 에 한 번에 붙여넣기 위한 편의 파일이며,
 * 원본은 supabase/migrations/*.sql 이다. 원본을 고치면 이 스크립트를 다시 돌린다.
 *
 *   node scripts/build-setup-sql.mjs
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'supabase', 'migrations');

const files = readdirSync(dir)
  .filter((name) => name.endsWith('.sql'))
  .sort();

const header = `-- ============================================================
-- Event Alpha Korea — 통합 설치 스크립트 (자동 생성)
--
-- 이 파일은 supabase/migrations/*.sql 를 합친 것이다.
-- 직접 고치지 말고 원본을 고친 뒤 다시 생성할 것:
--   npm run db:sql
--
-- 사용법: Supabase 대시보드 > SQL Editor 에 전체를 붙여넣고 Run.
-- 재실행해도 안전하다(idempotent).
-- 포함: ${files.join(', ')}
-- ============================================================

`;

const body = files
  .map((name) => {
    const sql = readFileSync(join(dir, name), 'utf8').trimEnd();
    return `-- ┌───────────────────────────────────────────────────────────\n-- │ ${name}\n-- └───────────────────────────────────────────────────────────\n\n${sql}\n`;
  })
  .join('\n\n');

const out = join(root, 'supabase', 'setup.sql');
writeFileSync(out, header + body, 'utf8');

console.log(`생성 완료: supabase/setup.sql (${files.length}개 파일, ${(header + body).length.toLocaleString()}자)`);
