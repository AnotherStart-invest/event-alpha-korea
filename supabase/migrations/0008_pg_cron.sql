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
