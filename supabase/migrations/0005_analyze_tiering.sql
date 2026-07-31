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
