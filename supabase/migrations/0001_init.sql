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
