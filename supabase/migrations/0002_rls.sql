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
