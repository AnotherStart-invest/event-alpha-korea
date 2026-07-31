-- Event Alpha Korea — 0004. 무료 경로(MVP)
--
-- 배경: 후보 생성이 company_exposures 에만 의존했는데, 그걸 채우는 build_profiles 는
-- 기업당 LLM 5회를 쓴다. 무료 티어(하루 20회)로는 하루 4개 기업이 한계라
-- 3,925 종목을 채울 방법이 없었고, 그래서 event_impacts 가 0 이었다.
--
-- 이 마이그레이션은 **LLM 없이** 같은 자리를 채우기 위한 뼈대를 추가한다.
--   1) KRX 상장목록(무료·무인증)에서 오는 시장·업종·주요제품
--   2) 폐지된 껍데기 종목 배제 (DART corpCode.xml 에는 상장폐지 법인도 들어 있다)
--   3) MVP 동안 사람 검수 없이 공개하기 위한 스위치
--
-- 재실행해도 안전하다.

-- ─── 1. 상장 여부 / 주요제품 ─────────────────────────────────
-- is_listed 기본값을 true 로 두는 이유: 이 마이그레이션만 적용하고
-- sync_krx 를 아직 안 돌린 상태에서도 공개 화면이 비지 않도록.
alter table companies add column if not exists is_listed     boolean not null default true;
alter table companies add column if not exists main_products  text;
alter table companies add column if not exists krx_synced_at  timestamptz;

comment on column companies.is_listed is
  'KRX 상장목록에 현재 존재하는가. sync_krx 가 갱신한다. false 는 상장폐지·이관된 껍데기.';
comment on column companies.main_products is
  'KRX 상장목록의 "주요제품" 원문. LLM 이 아니라 거래소 공시 데이터다.';

create index if not exists companies_listed_only_idx
  on companies (stock_code) where stock_code is not null and is_listed;

-- 상장폐지 종목이 공개 화면에 나오면 안 된다 (제품 불변식 I2 강화).
drop policy if exists companies_public_read on companies;
create policy companies_public_read on companies
  for select to anon, authenticated
  using (stock_code is not null and is_listed);

drop policy if exists exposures_public_read on company_exposures;
create policy exposures_public_read on company_exposures
  for select to anon, authenticated
  using (
    exists (
      select 1 from companies c
      where c.id = company_id and c.stock_code is not null and c.is_listed
    )
  );

-- ─── 2. MVP 자동 공개 스위치 ─────────────────────────────────
-- 기본값 false. 켜면 analyze/mentions 잡이 검수 대기를 거치지 않고 바로 공개한다.
-- 관리자 검수 흐름은 코드에 그대로 남아 있으므로 언제든 끄면 원래대로 돌아간다.
alter table app_settings add column if not exists auto_publish boolean not null default false;
alter table app_settings add column if not exists mentions_enabled boolean not null default true;

comment on column app_settings.auto_publish is
  'MVP 전용. true 면 사람 검수 없이 published 로 전환한다. 운영 전환 시 false 로 되돌릴 것.';

-- ─── 3. 근거 조회 인덱스 ─────────────────────────────────────
-- 언급 매칭이 (기업, 기사 URL) 로 기존 근거를 찾아 재사용한다.
-- 유일 제약을 걸지 않는 이유: 부분 유일 인덱스는 PostgREST 의 upsert 가
-- ON CONFLICT 추론에 실패한다. 중복 방지는 애플리케이션에서 조회 후 삽입으로 한다.
create index if not exists evidence_company_url_idx
  on evidence_sources (company_id, source_url)
  where company_id is not null;
