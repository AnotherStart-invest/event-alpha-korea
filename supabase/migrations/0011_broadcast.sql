-- Event Alpha Korea — 0011. 텔레그램 발송 기록
--
-- 채널에 같은 이벤트를 두 번 올리면 신뢰가 즉시 깎인다. cron 은 재실행이 잦으므로
-- (배포·재시도·중복 tick) "보냈다" 를 DB 에 남겨야 한다. 메모리나 로그로는 안 된다.
--
-- traced_at(0007) 과 같은 패턴이다 — 실패해도 시각을 남겨 무한 재시도를 막는다.
-- 다만 여기서는 실패 시 남기지 않는다. 발송 실패는 재시도해야 할 일이고,
-- 아래 last_error 로 무엇이 막혔는지 본다.

alter table events
  add column if not exists broadcast_at timestamptz;

comment on column events.broadcast_at is
  '텔레그램 채널에 게시한 시각. null 이면 아직 안 보냈다. '
  '중복 게시 방지용이며, 다시 보내려면 null 로 되돌린다.';

-- 발송 대상 조회가 이 인덱스를 탄다.
create index if not exists events_unbroadcast_idx
  on events (published_at desc)
  where broadcast_at is null and status = 'published';
