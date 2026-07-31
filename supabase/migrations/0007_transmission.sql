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
