-- ============================================================
-- Event Alpha Korea — 통합 설치 스크립트 (자동 생성)
--
-- 이 파일은 supabase/migrations/*.sql 를 합친 것이다.
-- 직접 고치지 말고 원본을 고친 뒤 다시 생성할 것:
--   npm run db:sql
--
-- 사용법: Supabase 대시보드 > SQL Editor 에 전체를 붙여넣고 Run.
-- 재실행해도 안전하다(idempotent).
-- 포함: 0001_init.sql, 0002_rls.sql, 0003_seed.sql, 0004_mvp_free_path.sql, 0005_analyze_tiering.sql, 0006_peer_expansion.sql, 0007_transmission.sql, 0008_pg_cron.sql
-- ============================================================

-- ┌───────────────────────────────────────────────────────────
-- │ 0001_init.sql
-- └───────────────────────────────────────────────────────────

-- Event Alpha Korea — 스키마 초기화
-- 재실행 가능(idempotent)하도록 작성한다.

create extension if not exists vector;
create extension if not exists pg_trgm;
create extension if not exists pgcrypto;

-- ─── enum ────────────────────────────────────────────────────
do $$
begin
  if not exists (select 1 from pg_type where typname = 'market_type') then
    create type market_type as enum ('KOSPI','KOSDAQ','KONEX');
  end if;
  if not exists (select 1 from pg_type where typname = 'verification_status') then
    create type verification_status as enum ('unverified','auto','reviewed','rejected');
  end if;
  if not exists (select 1 from pg_type where typname = 'event_type') then
    create type event_type as enum (
      'policy_regulation','tariff_trade','commodity_price','supply_disruption',
      'production_halt','major_order','contract_change','ma_control',
      'asset_sale','geopolitics_logistics');
  end if;
  if not exists (select 1 from pg_type where typname = 'event_status') then
    create type event_status as enum (
      'candidate','analyzing','analyzed','pending_review','published','rejected','failed');
  end if;
  if not exists (select 1 from pg_type where typname = 'time_horizon') then
    create type time_horizon as enum ('immediate','short','mid','long','unknown');
  end if;
  if not exists (select 1 from pg_type where typname = 'variable_direction') then
    create type variable_direction as enum ('up','down','mixed','unknown');
  end if;
  if not exists (select 1 from pg_type where typname = 'impact_direction') then
    create type impact_direction as enum ('positive','negative','mixed','uncertain');
  end if;
  if not exists (select 1 from pg_type where typname = 'impact_level') then
    create type impact_level as enum ('high','medium','low');
  end if;
  if not exists (select 1 from pg_type where typname = 'relation_type') then
    create type relation_type as enum
      ('direct','indirect','supply_chain','competitor','substitute','thematic');
  end if;
  if not exists (select 1 from pg_type where typname = 'review_status') then
    create type review_status as enum ('pending','approved','rejected','edited');
  end if;
  if not exists (select 1 from pg_type where typname = 'exposure_type') then
    create type exposure_type as enum (
      'product','raw_material','customer','customer_industry','geography',
      'supplier','subsidiary','project','policy','commodity',
      'competitor','substitute','positive_variable','negative_variable');
  end if;
  if not exists (select 1 from pg_type where typname = 'evidence_source_type') then
    create type evidence_source_type as enum ('dart','news','company_ir','exchange','manual');
  end if;
  if not exists (select 1 from pg_type where typname = 'processing_status') then
    create type processing_status as enum ('pending','clustered','skipped','failed');
  end if;
end $$;

-- ─── 공통 트리거 함수 ─────────────────────────────────────────
create or replace function touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- ─── 기업 ────────────────────────────────────────────────────
create table if not exists companies (
  id                  uuid primary key default gen_random_uuid(),
  corp_code           text unique,
  stock_code          text unique,
  company_name        text not null,
  market              market_type,
  industry_code       text,
  industry_name       text,
  description         text,
  latest_report_date  date,
  verification_status verification_status not null default 'unverified',
  search_text         text,
  embedding           vector(1536),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint stock_code_format check (stock_code is null or stock_code ~ '^[0-9]{6}$')
);
create index if not exists companies_search_trgm on companies using gin (search_text gin_trgm_ops);
create index if not exists companies_name_trgm   on companies using gin (company_name gin_trgm_ops);
create index if not exists companies_listed_idx  on companies (stock_code) where stock_code is not null;
create index if not exists companies_embed_idx   on companies using hnsw (embedding vector_cosine_ops);

create table if not exists evidence_sources (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid references companies(id) on delete cascade,
  source_type  evidence_source_type not null,
  source_title text not null,
  source_url   text,
  report_id    text,
  source_date  date,
  excerpt      text,
  collected_at timestamptz not null default now(),
  constraint excerpt_len check (excerpt is null or length(excerpt) <= 500)
);
create index if not exists evidence_company_idx on evidence_sources (company_id, source_date desc);

create table if not exists company_exposures (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null references companies(id) on delete cascade,
  exposure_type      exposure_type not null,
  exposure_value     text not null,
  normalized_value   text not null,
  direction          variable_direction,
  strength           smallint check (strength between 0 and 100),
  revenue_share      numeric(5,2) check (revenue_share between 0 and 100),
  geography          text,
  source_evidence_id uuid references evidence_sources(id) on delete set null,
  verified           boolean not null default false,
  embedding          vector(1536),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint exposure_unique unique (company_id, exposure_type, normalized_value)
);
create index if not exists exposures_lookup_idx on company_exposures (exposure_type, normalized_value);
create index if not exists exposures_norm_trgm  on company_exposures using gin (normalized_value gin_trgm_ops);
create index if not exists exposures_company_idx on company_exposures (company_id);
create index if not exists exposures_embed_idx  on company_exposures using hnsw (embedding vector_cosine_ops);

create table if not exists synonyms (
  id         uuid primary key default gen_random_uuid(),
  term       text not null,
  alias      text not null,
  category   text,
  created_at timestamptz not null default now(),
  constraint synonym_unique unique (alias, term)
);
create index if not exists synonyms_alias_idx on synonyms (alias);

-- ─── 뉴스 ────────────────────────────────────────────────────
-- 주의: 기사 본문 컬럼을 두지 않는다 (저작권 원칙 I7).
create table if not exists news_articles (
  id                uuid primary key default gen_random_uuid(),
  title             text not null,
  cleaned_title     text not null,
  description       text,
  source_name       text,
  original_url      text,
  naver_url         text,
  published_at      timestamptz not null,
  collected_at      timestamptz not null default now(),
  query_keyword     text,
  title_hash        text not null,
  embedding         vector(1536),
  processing_status processing_status not null default 'pending',
  created_at        timestamptz not null default now(),
  constraint article_unique unique (title_hash, published_at)
);
create index if not exists articles_pending_idx on news_articles (processing_status, published_at desc);
create index if not exists articles_time_idx    on news_articles (published_at desc);
create index if not exists articles_embed_idx   on news_articles using hnsw (embedding vector_cosine_ops);

create table if not exists watch_keywords (
  id          uuid primary key default gen_random_uuid(),
  keyword     text not null unique,
  category    text,
  active      boolean not null default true,
  priority    smallint not null default 5,
  last_run_at timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists keywords_rotation_idx
  on watch_keywords (active, priority, last_run_at nulls first);

-- ─── 이벤트 ──────────────────────────────────────────────────
create table if not exists events (
  id                       uuid primary key default gen_random_uuid(),
  title                    text not null,
  factual_summary          text,
  event_type               event_type,
  status                   event_status not null default 'candidate',
  primary_variable         text,
  variable_direction       variable_direction not null default 'unknown',
  geography                text[] not null default '{}',
  time_horizon             time_horizon not null default 'unknown',
  event_confidence         smallint check (event_confidence between 0 and 100),
  novelty_score            smallint check (novelty_score between 0 and 100),
  affected_industries      text[] not null default '{}',
  affected_products        text[] not null default '{}',
  affected_raw_materials   text[] not null default '{}',
  affected_customer_groups text[] not null default '{}',
  cluster_key              text,
  embedding                vector(1536),
  retry_count              smallint not null default 0,
  last_error               text,
  event_occurred_at        timestamptz,
  published_at             timestamptz,
  reviewed_at              timestamptz,
  approved_at              timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  constraint published_requires_ts
    check (status <> 'published' or (published_at is not null and approved_at is not null))
);
create index if not exists events_queue_idx  on events (status, event_occurred_at desc);
create index if not exists events_public_idx on events (event_type, published_at desc) where status = 'published';
create index if not exists events_embed_idx  on events using hnsw (embedding vector_cosine_ops);

create table if not exists event_articles (
  event_id   uuid not null references events(id) on delete cascade,
  article_id uuid not null references news_articles(id) on delete cascade,
  is_primary boolean not null default false,
  similarity real,
  primary key (event_id, article_id)
);
create index if not exists event_articles_article_idx on event_articles (article_id);

create table if not exists event_transmission_steps (
  id          uuid primary key default gen_random_uuid(),
  event_id    uuid not null references events(id) on delete cascade,
  step_order  smallint not null,
  description text not null,
  constraint step_unique unique (event_id, step_order)
);

create table if not exists event_requirements (
  id               uuid primary key default gen_random_uuid(),
  event_id         uuid not null references events(id) on delete cascade,
  requirement_type text not null
    check (requirement_type in ('evidence_to_check','invalidation_condition','follow_up_event')),
  description      text not null,
  sort_order       smallint not null default 0
);
create index if not exists requirements_idx on event_requirements (event_id, requirement_type, sort_order);

create table if not exists event_impacts (
  id                uuid primary key default gen_random_uuid(),
  event_id          uuid not null references events(id) on delete cascade,
  company_id        uuid not null references companies(id) on delete cascade,
  impact_direction  impact_direction not null default 'uncertain',
  impact_level      impact_level not null default 'low',
  relation_type     relation_type not null default 'thematic',
  relevance_score   smallint not null check (relevance_score between 0 and 100),
  score_breakdown   jsonb not null default '{}'::jsonb,
  confidence_score  smallint check (confidence_score between 0 and 100),
  rationale         text,
  transmission_path text[] not null default '{}',
  evidence_summary  text,
  missing_evidence  text[] not null default '{}',
  review_status     review_status not null default 'pending',
  is_manual         boolean not null default false,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint impact_unique unique (event_id, company_id)
);
create index if not exists impacts_event_idx   on event_impacts (event_id, impact_direction, relevance_score desc);
create index if not exists impacts_company_idx on event_impacts (company_id, created_at desc);

create table if not exists event_impact_evidence (
  impact_id   uuid not null references event_impacts(id) on delete cascade,
  evidence_id uuid not null references evidence_sources(id) on delete cascade,
  primary key (impact_id, evidence_id)
);

-- ─── 운영 ────────────────────────────────────────────────────
create table if not exists profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  email      text not null,
  role       text not null default 'user' check (role in ('user','admin')),
  created_at timestamptz not null default now()
);

create table if not exists admin_reviews (
  id          uuid primary key default gen_random_uuid(),
  target_type text not null check (target_type in ('event','impact','company','exposure')),
  target_id   uuid not null,
  reviewer    uuid references profiles(id) on delete set null,
  action      text not null,
  comment     text,
  diff        jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists reviews_target_idx on admin_reviews (target_type, target_id, created_at desc);

create table if not exists pipeline_runs (
  id          uuid primary key default gen_random_uuid(),
  job_name    text not null,
  run_key     text not null,
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  ok          boolean,
  stats       jsonb not null default '{}'::jsonb,
  error       text,
  constraint run_unique unique (job_name, run_key)
);
create index if not exists runs_recent_idx on pipeline_runs (job_name, started_at desc);

create table if not exists llm_calls (
  id                 uuid primary key default gen_random_uuid(),
  purpose            text not null,
  provider           text not null,
  model              text not null,
  event_id           uuid references events(id) on delete set null,
  company_id         uuid references companies(id) on delete set null,
  input_tokens       integer not null default 0,
  output_tokens      integer not null default 0,
  estimated_cost_usd numeric(10,6) not null default 0,
  ok                 boolean not null default true,
  error              text,
  prompt_hash        text,
  created_at         timestamptz not null default now()
);
create index if not exists llm_recent_idx  on llm_calls (created_at desc);
create index if not exists llm_purpose_idx on llm_calls (purpose, created_at desc);

create table if not exists app_settings (
  id                   smallint primary key default 1 check (id = 1),
  daily_llm_budget_usd numeric(8,2) not null default 3.00,
  collect_enabled      boolean not null default true,
  analyze_enabled      boolean not null default true,
  max_events_per_tick  smallint not null default 3,
  updated_at           timestamptz not null default now()
);

-- ─── 트리거 부착 ─────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['companies','company_exposures','events','event_impacts']
  loop
    execute format('drop trigger if exists t_%1$s_touch on %1$s', t);
    execute format(
      'create trigger t_%1$s_touch before update on %1$s
       for each row execute function touch_updated_at()', t);
  end loop;
end $$;

-- ─── 비용 뷰 ─────────────────────────────────────────────────
-- security_invoker 필수: 뷰는 기본적으로 소유자 권한으로 실행되어
-- 하위 테이블(llm_calls)의 RLS 를 우회한다. 그대로 두면 anon 이
-- 운영 비용 데이터를 읽을 수 있다.
create or replace view v_llm_cost_today
with (security_invoker = on) as
select
  coalesce(sum(estimated_cost_usd), 0)::numeric as cost_usd,
  count(*)::bigint                              as calls
from llm_calls
where created_at >= date_trunc('day', now() at time zone 'Asia/Seoul') at time zone 'Asia/Seoul';

revoke all on v_llm_cost_today from anon;

-- ─── 파이프라인 잠금 (중복 cron 방지) ─────────────────────────
--
-- 세션 레벨 advisory lock 은 쓰지 않는다.
-- PostgREST 는 커넥션 풀을 쓰므로 lock 을 잡은 커넥션과 푸는 커넥션이
-- 다를 수 있고, 그러면 잠금이 영원히 안 풀려 모든 실행이 건너뛰어진다.
--
-- 대신 pipeline_runs 를 직접 본다. 끝나지 않은 최근 실행이 있으면 건너뛰고,
-- STALE_MINUTES 가 지나면 죽은 실행으로 보고 자동으로 회수한다.
create or replace function job_is_running(p_job text, p_stale_minutes int default 10)
returns boolean
language sql stable as $$
  select exists (
    select 1 from pipeline_runs
    where job_name = p_job
      and finished_at is null
      and started_at > now() - make_interval(mins => p_stale_minutes)
  );
$$;

-- ─── 임베딩 후보 검색 ─────────────────────────────────────────
-- pgvector 연산자를 PostgREST 로 직접 쓸 수 없어 RPC 로 감싼다.
-- 파라미터를 text 로 받아 함수 안에서 캐스팅한다.
-- PostgREST 가 JSON 문자열을 vector 타입으로 자동 변환해주지 않기 때문이다.
create or replace function match_exposures(
  p_embedding text,
  p_threshold float,
  p_limit     int
)
returns table (company_id uuid, exposure_id uuid, similarity float)
language sql stable as $$
  select e.company_id,
         e.id as exposure_id,
         1 - (e.embedding <=> p_embedding::vector(1536)) as similarity
  from company_exposures e
  join companies c on c.id = e.company_id
  where e.embedding is not null
    and c.stock_code is not null
    and 1 - (e.embedding <=> p_embedding::vector(1536)) >= p_threshold
  order by e.embedding <=> p_embedding::vector(1536)
  limit p_limit;
$$;


-- ┌───────────────────────────────────────────────────────────
-- │ 0002_rls.sql
-- └───────────────────────────────────────────────────────────

-- Event Alpha Korea — RLS
--
-- 원칙: anon 은 published 이벤트와 상장 기업만 읽는다.
-- 쓰기는 전부 service_role(RLS 우회) 또는 admin.
--
-- 주의: 이벤트의 "조각" 테이블(articles/steps/requirements/impact_evidence)에도
-- 부모 이벤트의 published 조건을 각각 걸어야 한다. 하나라도 빠지면 미승인
-- 이벤트의 내용이 새어나간다.

-- ─── admin 판정 함수 ─────────────────────────────────────────
create or replace function is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from profiles p
    where p.id = auth.uid() and p.role = 'admin'
  );
$$;

create or replace function event_is_published(p_event_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from events e
    where e.id = p_event_id and e.status = 'published'
  );
$$;

-- ─── RLS 활성화 ──────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array[
    'companies','company_exposures','evidence_sources','synonyms',
    'news_articles','watch_keywords',
    'events','event_articles','event_transmission_steps','event_requirements',
    'event_impacts','event_impact_evidence',
    'profiles','admin_reviews','pipeline_runs','llm_calls','app_settings'
  ]
  loop
    execute format('alter table %I enable row level security', t);
  end loop;
end $$;

-- 재실행 가능하도록 기존 정책 제거
do $$
declare r record;
begin
  for r in
    select schemaname, tablename, policyname
    from pg_policies where schemaname = 'public'
  loop
    execute format('drop policy if exists %I on %I.%I', r.policyname, r.schemaname, r.tablename);
  end loop;
end $$;

-- ─── 공개 읽기 ───────────────────────────────────────────────
create policy events_public_read on events
  for select to anon, authenticated
  using (status = 'published');

create policy impacts_public_read on event_impacts
  for select to anon, authenticated
  using (event_is_published(event_id) and relevance_score >= 20);

create policy event_articles_public_read on event_articles
  for select to anon, authenticated
  using (event_is_published(event_id));

create policy steps_public_read on event_transmission_steps
  for select to anon, authenticated
  using (event_is_published(event_id));

create policy requirements_public_read on event_requirements
  for select to anon, authenticated
  using (event_is_published(event_id));

create policy impact_evidence_public_read on event_impact_evidence
  for select to anon, authenticated
  using (
    exists (
      select 1 from event_impacts i
      where i.id = impact_id and event_is_published(i.event_id)
    )
  );

-- 기사는 공개된 이벤트에 연결된 것만 (수집만 되고 미분석인 기사는 노출 금지)
create policy articles_public_read on news_articles
  for select to anon, authenticated
  using (
    exists (
      select 1 from event_articles ea
      where ea.article_id = news_articles.id and event_is_published(ea.event_id)
    )
  );

-- 상장사만 공개 (제품 불변식 I2)
create policy companies_public_read on companies
  for select to anon, authenticated
  using (stock_code is not null);

create policy exposures_public_read on company_exposures
  for select to anon, authenticated
  using (
    exists (
      select 1 from companies c
      where c.id = company_id and c.stock_code is not null
    )
  );

create policy evidence_public_read on evidence_sources
  for select to anon, authenticated
  using (
    company_id is null or exists (
      select 1 from companies c
      where c.id = company_id and c.stock_code is not null
    )
  );

-- ─── 관리자 전체 접근 ────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array[
    'companies','company_exposures','evidence_sources','synonyms',
    'news_articles','watch_keywords',
    'events','event_articles','event_transmission_steps','event_requirements',
    'event_impacts','event_impact_evidence',
    'admin_reviews','pipeline_runs','llm_calls','app_settings'
  ]
  loop
    execute format(
      'create policy %1$s_admin_all on %1$I for all to authenticated
       using (is_admin()) with check (is_admin())', t);
  end loop;
end $$;

-- ─── profiles ────────────────────────────────────────────────
create policy profiles_self_read on profiles
  for select to authenticated
  using (id = auth.uid() or is_admin());

create policy profiles_self_update on profiles
  for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid() and role = 'user');

create policy profiles_admin_all on profiles
  for all to authenticated
  using (is_admin()) with check (is_admin());

-- ─── 신규 가입자 프로필 자동 생성 ─────────────────────────────
create or replace function handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id, email, role)
  values (new.id, coalesce(new.email, ''), 'user')
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();


-- ┌───────────────────────────────────────────────────────────
-- │ 0003_seed.sql
-- └───────────────────────────────────────────────────────────

-- Event Alpha Korea — 시드 데이터
-- 재실행해도 중복이 생기지 않도록 전부 on conflict do nothing / do update.

-- ─── 운영 설정 ───────────────────────────────────────────────
insert into app_settings (id, daily_llm_budget_usd, collect_enabled, analyze_enabled, max_events_per_tick)
values (1, 3.00, true, true, 3)
on conflict (id) do nothing;

-- ─── 감시 키워드 ─────────────────────────────────────────────
insert into watch_keywords (keyword, category, priority) values
  ('관세',          'tariff_trade',           1),
  ('관세 인상',     'tariff_trade',           1),
  ('수출 제한',     'tariff_trade',           1),
  ('수입 규제',     'tariff_trade',           1),
  ('수출 통제',     'tariff_trade',           1),
  ('반도체 규제',   'tariff_trade',           1),
  ('무역 제재',     'tariff_trade',           2),
  ('보조금',        'policy_regulation',      2),
  ('세액공제',      'policy_regulation',      3),
  ('규제 완화',     'policy_regulation',      3),
  ('인허가',        'policy_regulation',      4),
  ('공급 중단',     'supply_disruption',      1),
  ('공급망 차질',   'supply_disruption',      1),
  ('부품 부족',     'supply_disruption',      2),
  ('공장 화재',     'production_halt',        1),
  ('가동 중단',     'production_halt',        1),
  ('파업',          'production_halt',        2),
  ('대규모 수주',   'major_order',            2),
  ('수주',          'major_order',            3),
  ('낙찰',          'major_order',            3),
  ('계약 체결',     'contract_change',        3),
  ('계약 해지',     'contract_change',        2),
  ('공급계약',      'contract_change',        3),
  ('인수합병',      'ma_control',             3),
  ('경영권 변경',   'ma_control',             3),
  ('지분 매각',     'ma_control',             4),
  ('자산 매각',     'asset_sale',             4),
  ('사업부 매각',   'asset_sale',             4),
  ('원유',          'commodity_price',        2),
  ('구리',          'commodity_price',        2),
  ('리튬',          'commodity_price',        2),
  ('희토류',        'commodity_price',        1),
  ('니켈',          'commodity_price',        3),
  ('LNG',           'commodity_price',        2),
  ('해상풍력',      'policy_regulation',      3),
  ('전력망',        'policy_regulation',      3),
  ('데이터센터',    'policy_regulation',      3),
  ('해협 봉쇄',     'geopolitics_logistics',  1),
  ('물류 대란',     'geopolitics_logistics',  2),
  ('운임 급등',     'geopolitics_logistics',  3)
on conflict (keyword) do update
  set category = excluded.category,
      priority = excluded.priority;

-- ─── 동의어 사전 ─────────────────────────────────────────────
-- alias(이형태) → term(정규형). 매칭 품질을 좌우하는 핵심 데이터.
-- 관리자 화면에서 계속 추가한다.
insert into synonyms (term, alias, category) values
  -- 전력기기
  ('변압기', 'transformer', 'product'),
  ('변압기', '초고압변압기', 'product'),
  ('변압기', '주상변압기', 'product'),
  ('변압기', '전력변압기', 'product'),
  ('전력망', '송배전망', 'product'),
  ('전력망', '그리드', 'product'),
  ('전력망', 'grid', 'product'),
  ('전력망', '전력계통', 'product'),
  ('전선', '케이블', 'product'),
  ('전선', '해저케이블', 'product'),
  ('개폐기', 'switchgear', 'product'),
  -- 이차전지
  ('이차전지', '2차전지', 'product'),
  ('이차전지', '배터리', 'product'),
  ('이차전지', 'battery', 'product'),
  ('이차전지', 'LIB', 'product'),
  ('양극재', '양극활물질', 'product'),
  ('음극재', '음극활물질', 'product'),
  ('분리막', 'separator', 'product'),
  ('전해액', 'electrolyte', 'product'),
  ('리튬', '탄산리튬', 'raw_material'),
  ('리튬', '수산화리튬', 'raw_material'),
  ('리튬', 'lithium', 'raw_material'),
  ('니켈', 'nickel', 'raw_material'),
  ('코발트', 'cobalt', 'raw_material'),
  ('흑연', 'graphite', 'raw_material'),
  ('희토류', '희토', 'raw_material'),
  ('희토류', 'rare earth', 'raw_material'),
  ('희토류', '네오디뮴', 'raw_material'),
  -- 반도체
  ('반도체', 'semiconductor', 'product'),
  ('메모리반도체', 'DRAM', 'product'),
  ('메모리반도체', '디램', 'product'),
  ('메모리반도체', '낸드', 'product'),
  ('메모리반도체', 'NAND', 'product'),
  ('메모리반도체', 'HBM', 'product'),
  ('시스템반도체', '비메모리', 'product'),
  ('시스템반도체', '파운드리', 'product'),
  ('반도체 장비', '전공정 장비', 'product'),
  ('반도체 장비', '후공정 장비', 'product'),
  ('반도체 소재', '포토레지스트', 'product'),
  ('반도체 소재', '불화수소', 'product'),
  ('반도체 소재', '에폭시', 'product'),
  -- 조선·해운
  ('조선', '선박 건조', 'product'),
  ('LNG운반선', 'LNG선', 'product'),
  ('LNG운반선', 'LNG carrier', 'product'),
  ('컨테이너선', '컨테이너 선박', 'product'),
  ('해운', '컨테이너 운송', 'product'),
  ('운임', '해상운임', 'product'),
  ('운임', 'SCFI', 'product'),
  -- 방산·항공
  ('방산', '방위산업', 'product'),
  ('방산', 'defense', 'product'),
  ('자주포', 'K9', 'product'),
  ('전차', 'K2', 'product'),
  -- 에너지
  ('원자력', '원전', 'product'),
  ('원자력', 'SMR', 'product'),
  ('해상풍력', '풍력발전', 'product'),
  ('해상풍력', '하부구조물', 'product'),
  ('태양광', '태양전지', 'product'),
  ('태양광', '폴리실리콘', 'product'),
  ('수소', '그린수소', 'product'),
  ('수소', '연료전지', 'product'),
  ('LNG', '액화천연가스', 'raw_material'),
  ('원유', 'WTI', 'raw_material'),
  ('원유', '두바이유', 'raw_material'),
  ('원유', 'brent', 'raw_material'),
  ('나프타', 'naphtha', 'raw_material'),
  -- 소재
  ('구리', '전기동', 'raw_material'),
  ('구리', 'copper', 'raw_material'),
  ('철광석', 'iron ore', 'raw_material'),
  ('철강', '열연', 'product'),
  ('철강', '냉연', 'product'),
  ('철강', '후판', 'product'),
  ('알루미늄', 'aluminium', 'raw_material'),
  ('알루미늄', 'aluminum', 'raw_material'),
  ('요소', '요소수', 'raw_material'),
  -- 자동차
  ('자동차부품', '차부품', 'product'),
  ('전기차', 'EV', 'product'),
  ('전기차', '전동화', 'product'),
  ('자율주행', 'ADAS', 'product'),
  -- 바이오
  ('바이오시밀러', '바이오 시밀러', 'product'),
  ('위탁생산', 'CMO', 'product'),
  ('위탁개발생산', 'CDMO', 'product'),
  ('임상시험수탁', 'CRO', 'product'),
  -- 지역
  ('미국', 'US', 'geography'),
  ('미국', 'USA', 'geography'),
  ('미국', '북미', 'geography'),
  ('중국', 'China', 'geography'),
  ('중국', '중화권', 'geography'),
  ('유럽', 'EU', 'geography'),
  ('유럽', '구주', 'geography'),
  ('일본', 'Japan', 'geography'),
  ('동남아', '아세안', 'geography'),
  ('중동', '사우디', 'geography'),
  ('인도', 'India', 'geography'),
  -- 고객 산업
  ('데이터센터', 'IDC', 'customer_industry'),
  ('데이터센터', '하이퍼스케일러', 'customer_industry'),
  ('건설', '플랜트', 'customer_industry'),
  ('조선업', '조선소', 'customer_industry'),
  ('통신', '5G', 'customer_industry'),
  ('가전', '생활가전', 'customer_industry')
on conflict (alias, term) do nothing;


-- ┌───────────────────────────────────────────────────────────
-- │ 0004_mvp_free_path.sql
-- └───────────────────────────────────────────────────────────

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


-- ┌───────────────────────────────────────────────────────────
-- │ 0005_analyze_tiering.sql
-- └───────────────────────────────────────────────────────────

-- Event Alpha Korea — 0005. 분석 단계 티어링
--
-- 배경: 이벤트 한 건을 분석하는 데 LLM 호출이 3회 들었다.
--   prefilter(cheap) → event_structure(standard) → impact(standard)
-- Gemini 무료 티어의 standard(gemini-3.5-flash)는 **하루 20회**라
-- 하루 10건이 상한이었다. 그래서 관련 종목이 붙은 이벤트가 거의 없었다.
--
-- 두 가지를 설정으로 뺀다.
--   1) 방향 판정(impact 호출)을 끌 수 있게 한다 — 이벤트당 호출이 절반이 된다.
--      끄더라도 "무엇과 겹치는가"는 노출 데이터로 결정론적으로 나오므로
--      관련 종목 자체는 그대로 뜬다. 못 하는 것은 긍정/부정 판정뿐이다.
--   2) 구조화 모델 티어를 고를 수 있게 한다.
--
-- 재실행해도 안전하다.

alter table app_settings
  add column if not exists judge_impacts boolean not null default false;

alter table app_settings
  add column if not exists structure_tier text not null default 'cheap';

-- 체크 제약은 별도로 건다(add column if not exists 와 함께 쓰면 재실행 시 중복된다).
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'app_settings_structure_tier_check'
  ) then
    alter table app_settings
      add constraint app_settings_structure_tier_check
      check (structure_tier in ('cheap', 'standard'));
  end if;
end $$;

comment on column app_settings.judge_impacts is
  'true 면 LLM 이 종목별 긍정·부정까지 판정한다. 이벤트당 LLM 호출이 2배가 되므로 '
  '무료 티어에서는 false 를 권장한다. false 여도 관련 종목은 결정론적으로 붙는다.';
comment on column app_settings.structure_tier is
  '이벤트 구조화에 쓸 모델 티어. 무료 티어의 standard 는 하루 20회 상한이라 cheap 이 기본.';


-- ┌───────────────────────────────────────────────────────────
-- │ 0006_peer_expansion.sql
-- └───────────────────────────────────────────────────────────

-- Event Alpha Korea — 0006. 동종 확장 스위치
--
-- 배경: 기사 직접 언급(mentions)만으로는 이벤트당 1~3종목이 한계였다.
-- 기사가 이름을 말한 종목만 잡히기 때문이다. 하지만 타이어 해상운임이 오르면
-- 기사에 안 나온 한국타이어도 같은 변수를 맞는다.
--
-- lib/events/peers.ts 가 이미 붙은 종목과 같은 주요제품을 파는 상장사를
-- 한 발 더 붙인다. LLM 을 부르지 않으므로 예산·한도와 무관하다.
--
-- 과잉 확장은 두 상한으로 막는다.
--   - 제품 용어 하나가 15개 넘는 기업을 끌고 오면 그 용어는 버린다
--     ("자동차부품" 44개, "반도체" 26개는 변별력이 없다)
--   - 이벤트당 동종 확장 종목은 12개까지
--
-- 재실행해도 안전하다.

alter table app_settings
  add column if not exists peers_enabled boolean not null default true;

comment on column app_settings.peers_enabled is
  'true 면 이벤트에 붙은 종목과 같은 제품군인 상장사를 추가로 붙인다(lib/events/peers.ts). '
  'LLM 을 쓰지 않는다. 관련 종목이 너무 많이 뜬다고 판단되면 이걸 끈다.';


-- ┌───────────────────────────────────────────────────────────
-- │ 0007_transmission.sql
-- └───────────────────────────────────────────────────────────

-- Event Alpha Korea — 0007. 전파 경로 추적
--
-- 배경: mentions(기사 언급)와 peers(같은 제품군)는 LLM 을 안 쓰는 대신 논리가 없다.
-- "이름이 나왔다", "같은 제품을 판다"는 사실일 뿐 인과가 아니고, 그래서 구조적으로
-- 못 잡는 게 있었다 — **수요 측 종목**이다. 철강값이 떨어지면 철강사는 부정적이지만
-- 철강을 사는 조선·자동차는 수혜인데 제품 매칭으로는 후자를 영원히 못 찾는다.
--
-- lib/events/transmission.ts 가 이벤트당 LLM 1회(cheap)로 전파 경로를 단계별로 받고,
-- 각 단계의 제품·업종 용어를 코드가 DB 에 매칭해 종목을 찾는다.
-- **LLM 은 기업명을 출력할 수 없다** — 스키마에 필드 자체가 없다.
--
-- 재실행해도 안전하다.

alter table app_settings
  add column if not exists transmission_enabled boolean not null default true;

comment on column app_settings.transmission_enabled is
  'true 면 이벤트당 LLM 1회로 전파 경로를 그리고 그 경로에 걸리는 종목을 찾는다'
  '(lib/events/transmission.ts). 무료 티어 한도를 아껴야 하면 이걸 끈다.';

-- 같은 이벤트에 LLM 을 두 번 쓰지 않도록 추적 완료 시각을 남긴다.
-- 여기서는 호출 수가 곧 한도라, 처리 여부를 상태가 아니라 별도 컬럼으로 들고 있어야
-- 이미 published 된 이벤트도 정확히 한 번만 추적된다.
alter table events
  add column if not exists traced_at timestamptz;

comment on column events.traced_at is
  '전파 경로 추적(lib/events/transmission.ts)을 시도한 시각. 경로를 못 그린 경우에도 채운다 — '
  '재시도하면 같은 결과에 한도만 쓴다. 다시 추적하려면 null 로 되돌린다.';

create index if not exists events_untraced_idx
  on events (event_occurred_at desc) where traced_at is null;


-- ┌───────────────────────────────────────────────────────────
-- │ 0008_pg_cron.sql
-- └───────────────────────────────────────────────────────────

-- Event Alpha Korea — 0008. 파이프라인 스케줄러를 GitHub Actions 에서 pg_cron 으로
--
-- 배경: `.github/workflows/cron.yml` 을 '*/5' 로 뒀는데 **실제로는 3시간에 1회** 돌았다.
-- GitHub Actions 의 schedule 은 "최소 5분"일 뿐 보장이 아니다. 부하가 높으면 지연되거나
-- 통째로 건너뛰고, 신규 저장소는 특히 후순위로 밀린다. 설정은 정상이었다
-- (저장소 public, 워크플로 active, 기본 브랜치 main). 스케줄러 자체의 성질이다.
--
-- pg_cron 은 Postgres 안에서 도는 스케줄러라 실제로 정확히 5분마다 실행된다.
-- 이미 쓰는 인프라라 계정도 비용도 늘지 않는다.
--
-- 재실행해도 안전하다(기존 잡을 지우고 다시 건다).

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- ─── 시크릿 ────────────────────────────────────────────────
-- CRON_SECRET 은 이 파일에 넣지 않는다. 공개 저장소에 커밋되기 때문이다.
-- 아래 한 줄을 **따로 한 번만** 실행해서 Vault 에 넣어야 한다:
--
--   select vault.create_secret('<CRON_SECRET 값>', 'cron_secret', 'pipeline cron 인증');
--
-- 값을 바꾸려면:
--   select vault.update_secret((select id from vault.secrets where name='cron_secret'), '<새 값>');

-- ─── 호출 함수 ─────────────────────────────────────────────
-- pg_net 은 비동기다. http_post 는 요청 id 만 돌려주고 응답을 기다리지 않는다.
-- 응답은 net._http_response 에 쌓이므로 실패 조사는 그 테이블을 본다.
create or replace function public.trigger_cron_job(job text)
returns bigint
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  secret text;
  request_id bigint;
begin
  -- 허용된 잡 이름만 받는다. 이 함수가 security definer 라 임의 경로 호출을 막아야 한다.
  if job not in ('collect', 'cluster', 'mentions', 'analyze', 'transmission', 'peers') then
    raise exception '알 수 없는 잡: %', job;
  end if;

  select decrypted_secret into secret
    from vault.decrypted_secrets where name = 'cron_secret' limit 1;
  if secret is null then
    raise exception 'vault 에 cron_secret 이 없습니다. 위 주석의 create_secret 을 먼저 실행하세요.';
  end if;

  select net.http_post(
    url := 'https://eventalpha.org/api/cron/' || job,
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || secret,
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000
  ) into request_id;

  return request_id;
end $$;

-- security definer 함수가 Vault 를 읽으므로 외부 롤에서 절대 부를 수 없어야 한다.
revoke all on function public.trigger_cron_job(text) from public, anon, authenticated;

-- ─── 스케줄 ────────────────────────────────────────────────
-- 잡에는 순서 의존이 있다(collect → cluster → mentions → analyze → transmission → peers).
-- pg_net 은 비동기라 동시에 쏘면 순서가 깨진다. 그래서 1분씩 어긋나게 건다.
--
-- transmission 만 15분 주기다. 이벤트당 LLM 1회를 쓰는데 5분마다 돌리면
-- 백로그가 있을 때 무료 한도를 몇 시간 만에 태운다. 한도에 걸리면
-- QuotaExceededError 로 멈추긴 하지만, 애초에 천천히 도는 편이 낫다.
do $$
declare
  j record;
begin
  for j in
    select jobname from cron.job
     where jobname in ('eak_collect','eak_cluster','eak_mentions','eak_analyze','eak_transmission','eak_peers')
  loop
    perform cron.unschedule(j.jobname);
  end loop;
end $$;

select cron.schedule('eak_collect',      '*/5 * * * *',    $$select public.trigger_cron_job('collect')$$);
select cron.schedule('eak_cluster',      '1-59/5 * * * *', $$select public.trigger_cron_job('cluster')$$);
select cron.schedule('eak_mentions',     '2-59/5 * * * *', $$select public.trigger_cron_job('mentions')$$);
select cron.schedule('eak_peers',        '3-59/5 * * * *', $$select public.trigger_cron_job('peers')$$);
select cron.schedule('eak_analyze',      '4-59/5 * * * *', $$select public.trigger_cron_job('analyze')$$);
select cron.schedule('eak_transmission', '7-59/15 * * * *', $$select public.trigger_cron_job('transmission')$$);

-- 확인용:
--   select jobname, schedule, active from cron.job where jobname like 'eak_%' order by jobname;
--   select jobname, status, return_message, start_time
--     from cron.job_run_details order by start_time desc limit 20;
--   select id, status_code, error_msg, created from net._http_response order by created desc limit 20;
