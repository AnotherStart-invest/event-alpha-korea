# Event Alpha Korea — 데이터베이스 스키마 (DATABASE_SCHEMA)

> 문서 버전 0.1 · 2026-07-31 · Phase 0 산출물
> 이 문서의 SQL은 Phase 2에서 `supabase/migrations/0001_init.sql` 등으로 그대로 옮긴다.

---

## 0. 원 요구안 대비 변경점

| # | 변경 | 이유 |
|---|---|---|
| C1 | `event_impacts.evidence_source_id` (단수) → **`event_impact_evidence` 조인 테이블** | 한 연결에 근거가 여럿인 경우가 일반적. 단수 FK는 곧 한계에 부딪힘 |
| C2 | `pipeline_runs` 테이블 추가 | 중복 cron 방지·실패 추적. 요구 테스트 항목("중복 cron 실행 방지") 충족에 필수 |
| C3 | `llm_calls` 테이블 추가 | 요구사항 "호출별 토큰과 추정 비용 저장" |
| C4 | `synonyms` 테이블 추가 | 요구사항 "동의어 사전" |
| C5 | `profiles` 테이블 추가 | Supabase Auth ↔ 관리자 role 연결 |
| C6 | `app_settings` 단일행 테이블 추가 | 일일 비용 상한 등 운영 스위치 |
| C7 | `news_articles.naver_url` 유지 + **본문 컬럼 없음** | 저작권 원칙 I7을 스키마로 강제 |
| C8 | `company_exposures.embedding` 컬럼 | 후보 검색을 exposure 단위로 하기 위함(회사 단위보다 정밀) |

문자열 상수는 전부 **Postgres enum**으로 만든다. TS `Database` 타입에 그대로 들어와 오타를 컴파일 타임에 잡는다.

---

## 1. 확장 · Enum

```sql
create extension if not exists vector;
create extension if not exists pg_trgm;
create extension if not exists pgcrypto;

create type market_type        as enum ('KOSPI','KOSDAQ','KONEX');
create type verification_status as enum ('unverified','auto','reviewed','rejected');

create type event_type as enum (
  'policy_regulation','tariff_trade','commodity_price','supply_disruption',
  'production_halt','major_order','contract_change','ma_control',
  'asset_sale','geopolitics_logistics'
);
create type event_status as enum (
  'candidate','analyzing','analyzed','pending_review',
  'published','rejected','failed'
);
create type time_horizon    as enum ('immediate','short','mid','long','unknown');
create type variable_direction as enum ('up','down','mixed','unknown');

create type impact_direction as enum ('positive','negative','mixed','uncertain');
create type impact_level     as enum ('high','medium','low');
create type relation_type    as enum ('direct','indirect','supply_chain','competitor','substitute','thematic');
create type review_status    as enum ('pending','approved','rejected','edited');

create type exposure_type as enum (
  'product','raw_material','customer','customer_industry','geography',
  'supplier','subsidiary','project','policy','commodity',
  'competitor','substitute','positive_variable','negative_variable'
);
create type evidence_source_type as enum ('dart','news','company_ir','exchange','manual');
create type processing_status as enum ('pending','clustered','skipped','failed');
```

---

## 2. 기업 도메인

```sql
create table companies (
  id                uuid primary key default gen_random_uuid(),
  corp_code         text unique,                 -- OpenDART 8자리
  stock_code        text unique,                 -- 6자리. NULL이면 비상장/공개제외(I2)
  company_name      text not null,
  market            market_type,
  industry_code     text,
  industry_name     text,
  description       text,
  latest_report_date date,
  verification_status verification_status not null default 'unverified',
  search_text       text,                        -- 검색용 사전 결합 텍스트
  embedding         vector(1536),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint stock_code_format check (stock_code is null or stock_code ~ '^[0-9]{6}$')
);
create index on companies using gin (search_text gin_trgm_ops);
create index on companies using hnsw (embedding vector_cosine_ops);
create index companies_listed_idx on companies (stock_code) where stock_code is not null;
```

```sql
create table evidence_sources (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid references companies(id) on delete cascade,
  source_type  evidence_source_type not null,
  source_title text not null,
  source_url   text,
  report_id    text,                 -- DART rcept_no 등
  source_date  date,
  excerpt      text,                 -- 2문장 이내 발췌만 (§저작권)
  collected_at timestamptz not null default now(),
  constraint excerpt_len check (excerpt is null or length(excerpt) <= 500)
);
create index on evidence_sources (company_id, source_date desc);
```

```sql
create table company_exposures (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references companies(id) on delete cascade,
  exposure_type     exposure_type not null,
  exposure_value    text not null,          -- 원문 표기
  normalized_value  text not null,          -- 소문자·공백제거·기호제거
  direction         variable_direction,     -- positive/negative_variable에서 사용
  strength          smallint check (strength between 0 and 100),
  revenue_share     numeric(5,2) check (revenue_share between 0 and 100),
  geography         text,
  source_evidence_id uuid references evidence_sources(id) on delete set null,
  verified          boolean not null default false,
  embedding         vector(1536),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (company_id, exposure_type, normalized_value)
);
create index on company_exposures (exposure_type, normalized_value);
create index on company_exposures using gin (normalized_value gin_trgm_ops);
create index on company_exposures using hnsw (embedding vector_cosine_ops);
```

> `unique (company_id, exposure_type, normalized_value)` 가 프로필 재생성의 **멱등성**을 보장한다.
> 재실행 시 `on conflict … do update`.

```sql
create table synonyms (
  id         uuid primary key default gen_random_uuid(),
  term       text not null,          -- 정규형 (예: '변압기')
  alias      text not null,          -- 이형태 (예: 'transformer', '전력변압기', '주상변압기')
  category   text,                   -- product / material / geography / industry
  created_at timestamptz not null default now(),
  unique (alias, term)
);
create index on synonyms (alias);
```

---

## 3. 뉴스 도메인

```sql
create table news_articles (
  id            uuid primary key default gen_random_uuid(),
  title         text not null,
  cleaned_title text not null,
  description   text,                -- 네이버 제공 발췌만. 본문 저장 금지(I7)
  source_name   text,
  original_url  text,
  naver_url     text,
  published_at  timestamptz not null,
  collected_at  timestamptz not null default now(),
  query_keyword text,
  title_hash    text not null,       -- normalize(cleaned_title) 의 sha256
  embedding     vector(1536),
  processing_status processing_status not null default 'pending',
  created_at    timestamptz not null default now(),
  unique (title_hash, published_at)  -- 재수집 멱등성
);
create index on news_articles (processing_status, published_at desc);
create index on news_articles (published_at desc);
create index on news_articles using hnsw (embedding vector_cosine_ops);
```

> **본문(body/content) 컬럼이 없다.** 이것이 저작권 원칙의 구조적 보장이다.
> `unique(title_hash, published_at)` — 같은 기사가 여러 키워드로 잡혀도 1행.

```sql
create table watch_keywords (
  id          uuid primary key default gen_random_uuid(),
  keyword     text not null unique,
  category    text,                    -- event_type 힌트
  active      boolean not null default true,
  priority    smallint not null default 5,   -- 1(높음)~9
  last_run_at timestamptz,              -- 라운드로빈 커서
  created_at  timestamptz not null default now()
);
create index on watch_keywords (active, priority, last_run_at nulls first);
```

---

## 4. 이벤트 도메인

```sql
create table events (
  id                 uuid primary key default gen_random_uuid(),
  title              text not null,
  factual_summary    text,
  event_type         event_type,
  status             event_status not null default 'candidate',
  primary_variable   text,
  variable_direction variable_direction default 'unknown',
  geography          text[] not null default '{}',
  time_horizon       time_horizon not null default 'unknown',
  event_confidence   smallint check (event_confidence between 0 and 100),
  novelty_score      smallint check (novelty_score between 0 and 100),
  -- 매칭 입력 키워드 (S5 산출물, S6 입력)
  affected_industries      text[] not null default '{}',
  affected_products        text[] not null default '{}',
  affected_raw_materials   text[] not null default '{}',
  affected_customer_groups text[] not null default '{}',
  cluster_key        text,          -- 클러스터링 시드 해시
  embedding          vector(1536),
  retry_count        smallint not null default 0,
  last_error         text,
  event_occurred_at  timestamptz,   -- 대표 기사 발행시각
  published_at       timestamptz,
  reviewed_at        timestamptz,
  approved_at        timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint published_requires_ts
    check (status <> 'published' or (published_at is not null and approved_at is not null))
);
create index on events (status, event_occurred_at desc);
create index on events (event_type, published_at desc) where status = 'published';
create index on events using hnsw (embedding vector_cosine_ops);
```

```sql
create table event_articles (
  event_id   uuid not null references events(id) on delete cascade,
  article_id uuid not null references news_articles(id) on delete cascade,
  is_primary boolean not null default false,
  similarity real,
  primary key (event_id, article_id)
);

create table event_transmission_steps (
  id          uuid primary key default gen_random_uuid(),
  event_id    uuid not null references events(id) on delete cascade,
  step_order  smallint not null,
  description text not null,
  unique (event_id, step_order)
);

create table event_requirements (
  id               uuid primary key default gen_random_uuid(),
  event_id         uuid not null references events(id) on delete cascade,
  requirement_type text not null
    check (requirement_type in ('evidence_to_check','invalidation_condition','follow_up_event')),
  description      text not null,
  sort_order       smallint not null default 0
);
create index on event_requirements (event_id, requirement_type, sort_order);
```

```sql
create table event_impacts (
  id               uuid primary key default gen_random_uuid(),
  event_id         uuid not null references events(id) on delete cascade,
  company_id       uuid not null references companies(id) on delete cascade,
  impact_direction impact_direction not null default 'uncertain',
  impact_level     impact_level not null default 'low',
  relation_type    relation_type not null default 'thematic',
  relevance_score  smallint not null check (relevance_score between 0 and 100),
  score_breakdown  jsonb not null default '{}'::jsonb,   -- 7개 항목 점수 (툴팁용)
  confidence_score smallint check (confidence_score between 0 and 100),
  rationale        text,
  transmission_path text[] not null default '{}',
  evidence_summary text,
  missing_evidence text[] not null default '{}',
  review_status    review_status not null default 'pending',
  is_manual        boolean not null default false,        -- 관리자가 직접 추가
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (event_id, company_id)
);
create index on event_impacts (event_id, impact_direction, relevance_score desc);
create index on event_impacts (company_id, created_at desc);

create table event_impact_evidence (
  impact_id   uuid not null references event_impacts(id) on delete cascade,
  evidence_id uuid not null references evidence_sources(id) on delete cascade,
  primary key (impact_id, evidence_id)
);
```

> `unique(event_id, company_id)` — 재분석해도 종목이 중복 생기지 않는다(멱등).

---

## 5. 운영 도메인

```sql
create table profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  email      text not null,
  role       text not null default 'user' check (role in ('user','admin')),
  created_at timestamptz not null default now()
);

create table admin_reviews (
  id          uuid primary key default gen_random_uuid(),
  target_type text not null check (target_type in ('event','impact','company','exposure')),
  target_id   uuid not null,
  reviewer    uuid references profiles(id),
  action      text not null,     -- approve/reject/edit/unpublish/reanalyze/add_impact/remove_impact
  comment     text,
  diff        jsonb,             -- 변경 전후
  created_at  timestamptz not null default now()
);
create index on admin_reviews (target_type, target_id, created_at desc);

create table pipeline_runs (
  id         uuid primary key default gen_random_uuid(),
  job_name   text not null,            -- collect/cluster/analyze/profile
  run_key    text not null,            -- 예: 'analyze:2026-07-31T14:20'
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  ok         boolean,
  stats      jsonb not null default '{}'::jsonb,
  error      text,
  unique (job_name, run_key)           -- 중복 cron 차단
);

create table llm_calls (
  id            uuid primary key default gen_random_uuid(),
  purpose       text not null,          -- prefilter/event_structure/impact/company_profile
  provider      text not null,
  model         text not null,
  event_id      uuid references events(id) on delete set null,
  company_id    uuid references companies(id) on delete set null,
  input_tokens  integer not null default 0,
  output_tokens integer not null default 0,
  estimated_cost_usd numeric(10,6) not null default 0,
  ok            boolean not null default true,
  error         text,
  prompt_hash   text,                   -- 동일 입력 재호출 감지
  created_at    timestamptz not null default now()
);
create index on llm_calls (created_at desc);
create index on llm_calls (purpose, created_at desc);

create table app_settings (
  id                    smallint primary key default 1 check (id = 1),
  daily_llm_budget_usd  numeric(8,2) not null default 3.00,
  collect_enabled       boolean not null default true,
  analyze_enabled       boolean not null default true,
  max_events_per_tick   smallint not null default 3,
  updated_at            timestamptz not null default now()
);
```

일일 비용 조회 뷰:

```sql
create view v_llm_cost_today as
select coalesce(sum(estimated_cost_usd),0) as cost_usd, count(*) as calls
from llm_calls
where created_at >= date_trunc('day', now() at time zone 'Asia/Seoul') at time zone 'Asia/Seoul';
```

---

## 6. RLS 정책

원칙: **anon은 published 이벤트와 상장 기업만 읽는다. 쓰기는 전부 service_role 또는 admin.**

```sql
alter table events               enable row level security;
alter table event_impacts        enable row level security;
alter table event_articles       enable row level security;
alter table event_transmission_steps enable row level security;
alter table event_requirements   enable row level security;
alter table news_articles        enable row level security;
alter table companies            enable row level security;
alter table company_exposures    enable row level security;
alter table evidence_sources     enable row level security;
alter table event_impact_evidence enable row level security;
alter table admin_reviews        enable row level security;
alter table profiles             enable row level security;
-- watch_keywords / pipeline_runs / llm_calls / app_settings 는 RLS on + 정책 없음(=admin·service만)

create or replace function is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles p where p.id = auth.uid() and p.role = 'admin');
$$;

-- 공개 읽기 (I8)
create policy events_public_read on events for select
  to anon, authenticated using (status = 'published');

create policy impacts_public_read on event_impacts for select
  to anon, authenticated using (
    exists (select 1 from events e where e.id = event_id and e.status = 'published')
    and relevance_score >= 20          -- R4
  );

create policy companies_public_read on companies for select
  to anon, authenticated using (stock_code is not null);   -- I2

create policy exposures_public_read on company_exposures for select
  to anon, authenticated using (
    exists (select 1 from companies c where c.id = company_id and c.stock_code is not null)
  );

create policy evidence_public_read on evidence_sources for select
  to anon, authenticated using (true);

-- 관리자 전체 접근 (모든 테이블에 동일 패턴)
create policy events_admin_all on events for all
  to authenticated using (is_admin()) with check (is_admin());
-- … 나머지 테이블 반복

create policy profiles_self_read on profiles for select
  to authenticated using (id = auth.uid() or is_admin());
```

**주의**: `event_articles`/`transmission_steps`/`requirements`/`impact_evidence`도 부모 event의
`status='published'` 조건을 각각 걸어야 한다. 하나라도 빠지면 미승인 이벤트의 조각이 새어나간다.
Phase 2 테스트에서 anon 키로 각 테이블을 직접 조회해 0행임을 확인한다.

---

## 7. 트리거

```sql
create or replace function touch_updated_at() returns trigger
language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

-- companies, company_exposures, events, event_impacts 에 적용
create trigger t_events_touch before update on events
for each row execute function touch_updated_at();
```

신규 가입자 profile 자동 생성 + ADMIN_EMAIL 승격은 seed에서 처리.

---

## 8. 시드 데이터

`watch_keywords` 초기값 (category = 대응 event_type 힌트):

| keyword | category | priority |
|---|---|---|
| 관세 | tariff_trade | 1 |
| 수출 제한 / 수입 규제 / 수출 통제 | tariff_trade | 1 |
| 보조금 | policy_regulation | 2 |
| 공급 중단 | supply_disruption | 1 |
| 공장 화재 / 파업 | production_halt | 1 |
| 대규모 수주 / 수주 | major_order | 2 |
| 계약 체결 / 계약 해지 | contract_change | 3 |
| 인수합병 / 경영권 변경 | ma_control | 3 |
| 자산 매각 | asset_sale | 4 |
| 원유 / 구리 / 리튬 / 희토류 / LNG | commodity_price | 2 |
| 해상풍력 / 전력망 / 데이터센터 | policy_regulation | 3 |
| 반도체 규제 | tariff_trade | 1 |

`app_settings` 1행, `synonyms` 초기 100~200쌍(변압기/transformer, 희토류/rare earth 등).

---

## 9. TypeScript 타입

```bash
npx supabase gen types typescript --project-id <ref> --schema public > lib/db/types.ts
```

- 생성 타입을 직접 수정하지 않는다. 도메인 타입은 `lib/db/models.ts`에서 파생
- Zod 스키마(`lib/llm/schemas.ts`)와 DB enum이 어긋나지 않도록 `satisfies` 대조 테스트를 둔다
