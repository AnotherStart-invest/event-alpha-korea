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
