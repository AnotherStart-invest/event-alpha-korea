-- Event Alpha Korea — 0009. 밸류체인 뷰
--
-- 두 가지 구멍을 메운다.
--
-- 1) 전파 단계와 종목의 연결이 끊겨 있었다.
--    lib/events/transmission.ts 는 종목이 몇 단계에서 걸렸는지 알면서도 그걸
--    rationale 문자열("(전파 2단계: …)")에만 남겼다. 컬럼이 없어 화면이 못 읽었고,
--    그래서 상세 페이지는 505개나 쌓인 단계 정보를 버리고 종목을 관련도 순
--    한 표로 평평하게 늘어놨다. step_order 를 실제 컬럼으로 승격한다.
--
-- 2) 기업 규모 데이터가 아예 없었다.
--    실측: 한 이벤트의 종목 10개가 **전부 35점 동점**이었다(제품 25 + 매출근거 5
--    + 공시 5). KRX 주요제품 문자열이 정확히 일치하면 무조건 이 점수라 관련도가
--    종목을 변별하지 못한다. 시가총액이 지금 유일하게 작동하는 정렬 축이다.
--
-- 재실행해도 안전하다.

-- ─── 1. 기업 규모 ────────────────────────────────────────────
alter table companies
  add column if not exists market_cap        bigint,
  add column if not exists shares_outstanding bigint,
  add column if not exists close_price       integer,
  add column if not exists price_updated_at  timestamptz;

comment on column companies.market_cap is
  '시가총액(원). python/scripts/sync_market_cap.py 가 네이버 금융에서 수집한다. '
  '억원이 아니라 원 단위다 — 화면 표기는 lib/shared/format.ts 의 formatMarketCap 이 맡는다.';
comment on column companies.shares_outstanding is '상장주식수(주). 시총 검산에 쓴다.';
comment on column companies.close_price is '수집 시점 종가(원). 시세 표시용이 아니라 시총 검산용이다.';
comment on column companies.price_updated_at is
  '시총을 마지막으로 갱신한 시각. 오래된 값은 화면에서 규모 배지를 흐리게 처리한다.';

-- 정렬이 이 인덱스를 탄다. null 은 항상 뒤로 보내므로 nulls last 로 맞춰 둔다.
create index if not exists companies_market_cap_idx
  on companies (market_cap desc nulls last) where stock_code is not null;

-- ─── 1-2. 사업 집중도 ────────────────────────────────────────
-- 관련도 점수가 종목을 변별하지 못하는 진짜 이유는 **매칭이 그 회사에서 얼마나
-- 중요한지를 재지 않기 때문**이다. KRX 주요제품에 "소프트웨어 개발"이 적혀 있기만
-- 하면 그게 유일한 사업이든 12개 중 하나든 똑같이 25점을 받는다.
--
-- 실측 (유학생 비자 이벤트에 붙은 10종목의 제품 가짓수):
--   라온시큐어 1 · 세미파이브 1 · 비상교육 2 · 썸에이지 2 · 유니포인트 3
--   이크레더블 3 · 주연테크 3 · 아이티센코어 6 · SK 8 · **사조산업 12**
-- 사조산업은 원양어업·참치통조림·냉동창고·부동산임대·팝콘 사이에 소프트웨어가
-- 끼어 있어서 걸린 것이다. 가짓수가 이 둘을 가른다.
alter table companies
  add column if not exists product_exposure_count integer not null default 0;

comment on column companies.product_exposure_count is
  '이 기업의 제품(product) 노출 개수. 매칭이 그 회사에서 차지하는 비중을 재는 분모다. '
  '적을수록 사업이 집중돼 있어 매칭 하나의 의미가 크다. 트리거가 자동으로 맞춘다.';

-- 트리거로 유지한다. company_exposures 는 sync_krx·build_profiles 두 곳에서
-- 배치로 들어오는데, 양쪽이 각자 세는 코드를 들고 있으면 반드시 어긋난다.
-- 문장 단위(statement-level) + 전이 테이블이라 7,000건 배치 upsert 에도 한 번만 돈다.
create or replace function sync_product_exposure_count() returns trigger
language plpgsql as $$
begin
  update companies c
     set product_exposure_count = coalesce(sub.n, 0)
    from (
      select t.company_id,
             (select count(*) from company_exposures e
               where e.company_id = t.company_id and e.exposure_type = 'product') as n
        from (select distinct company_id from changed_rows) t
    ) sub
   where c.id = sub.company_id;
  return null;
end $$;

drop trigger if exists exposures_count_ins on company_exposures;
create trigger exposures_count_ins
  after insert on company_exposures
  referencing new table as changed_rows
  for each statement execute function sync_product_exposure_count();

drop trigger if exists exposures_count_upd on company_exposures;
create trigger exposures_count_upd
  after update on company_exposures
  referencing new table as changed_rows
  for each statement execute function sync_product_exposure_count();

drop trigger if exists exposures_count_del on company_exposures;
create trigger exposures_count_del
  after delete on company_exposures
  referencing old table as changed_rows
  for each statement execute function sync_product_exposure_count();

-- 지금 있는 7,171건을 한 번 세어 둔다.
update companies c
   set product_exposure_count = coalesce(sub.n, 0)
  from (
    select c2.id,
           (select count(*) from company_exposures e
             where e.company_id = c2.id and e.exposure_type = 'product') as n
      from companies c2
  ) sub
 where c.id = sub.id
   and c.product_exposure_count is distinct from coalesce(sub.n, 0);

-- ─── 2. 전파 단계 메타 ───────────────────────────────────────
-- LLM 은 이미 단계마다 방향·관계·근거를 주고 있었다(transmissionStepSchema).
-- description 만 저장하고 나머지를 버려서 화면이 "이 단계가 수혜인지 피해인지"를
-- 말할 수 없었다.
alter table event_transmission_steps
  add column if not exists direction       impact_direction,
  add column if not exists relation        relation_type,
  add column if not exists reason          text,
  add column if not exists affected_terms  text[] not null default '{}',
  add column if not exists industry_terms  text[] not null default '{}',
  add column if not exists chain_position  text
    check (chain_position is null or chain_position in ('upstream', 'midstream', 'downstream'));

comment on column event_transmission_steps.affected_terms is
  '이 단계의 종목을 찾는 데 쓴 제품 검색어. 저장해 두면 점수 체계를 고쳤을 때 '
  'LLM 을 다시 부르지 않고 재채점할 수 있다 — 호출 수가 곧 한도인 무료 티어에서 중요하다.';

comment on column event_transmission_steps.direction is
  '이 단계에 걸리는 기업들 입장에서의 손익 방향. 같은 이벤트라도 단계마다 부호가 뒤집힌다 — '
  '철강값 하락은 철강사에 부정적이지만 철강을 사는 조선·자동차에는 긍정적이다.';
comment on column event_transmission_steps.chain_position is
  '밸류체인상 위치. 단계 순서에서 도출한다(첫 단계=upstream, 마지막=downstream). '
  'LLM 이 직접 판정하지 않는다 — 산업마다 축이 달라 억지 매핑이 되기 때문이다.';

-- ─── 3. 종목 ↔ 단계 연결 ─────────────────────────────────────
alter table event_impacts
  add column if not exists step_order smallint;

comment on column event_impacts.step_order is
  '이 종목이 걸린 전파 단계 번호(event_transmission_steps.step_order 와 짝). '
  'null 은 전파 경로가 아닌 다른 경로(기사 직접 언급·동종 확장)로 붙은 종목이다.';

create index if not exists impacts_step_idx on event_impacts (event_id, step_order);

-- ─── 4. 기존 데이터 백필 ─────────────────────────────────────
-- transmission.ts 가 남긴 rationale 꼬리표에서 단계 번호를 되살린다.
--   "…(전파 2단계: 반도체 업황 호황으로 …)"
-- 이 형식은 lib/events/transmission.ts 의 build() 가 만든다. 형식을 바꾸면
-- 이 정규식도 같이 바꿔야 하지만, 백필은 한 번만 도는 코드라 이후로는 무의미하다.
update event_impacts
   set step_order = (substring(rationale from '\(전파 ([0-9]+)단계:'))::smallint
 where step_order is null
   and rationale ~ '\(전파 [0-9]+단계:';

-- 단계 위치 라벨도 이미 저장된 행에 채워 넣는다.
-- 단계가 1개뿐이면 방향을 말할 수 없으므로 midstream 으로 둔다.
with bounds as (
  select event_id, max(step_order) as last_step, count(*) as n
    from event_transmission_steps
   group by event_id
)
update event_transmission_steps s
   set chain_position = case
         when b.n = 1                then 'midstream'
         when s.step_order = 1       then 'upstream'
         when s.step_order = b.last_step then 'downstream'
         else 'midstream'
       end
  from bounds b
 where b.event_id = s.event_id
   and s.chain_position is null;

-- ─── 5. RLS ──────────────────────────────────────────────────
-- 정책은 테이블 단위(0002)라 컬럼 추가는 자동으로 덮인다. 새 정책은 필요 없다.
-- 다만 anon 이 companies 를 읽을 때 market_cap 이 함께 나가는 것이 의도인지
-- 확인해 둔다 — 공개 정보이므로 문제없다.
