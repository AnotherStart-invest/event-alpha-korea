# Event Alpha Korea — 구현 계획 (IMPLEMENTATION_PLAN)

> 문서 버전 0.1 · 2026-07-31 · Phase 0 산출물

각 Phase 종료 시 보고 항목: ①구현 요약 ②변경 파일 ③실행 명령 ④테스트 결과 ⑤남은 문제 ⑥다음 단계

---

## Phase 0 — 설계 (완료)

산출물: `docs/PRODUCT_SPEC.md`, `ARCHITECTURE.md`, `DATABASE_SCHEMA.md`,
`IMPLEMENTATION_PLAN.md`, `LLM_PROMPTS.md`, `RISK_AND_LIMITATIONS.md`

---

## Phase 1 — 프로젝트 초기화

| 항목 | 내용 |
|---|---|
| 산출물 | Next.js 15 App Router + TS strict + Tailwind v4 + shadcn/ui, Supabase 클라이언트 3종, `.env.example`, 공통 레이아웃/헤더/푸터(고지문) |
| 주요 파일 | `app/layout.tsx`, `lib/db/{server,browser,service}.ts`, `lib/shared/{env,logger,errors,banned-words}.ts`, `components/ui/*` |
| 완료 조건 | `npm run build` 통과, `/`가 렌더됨, env 미설정 시 명확한 에러 |
| 테스트 | `banned-words` 린트 함수 단위 테스트 |

## Phase 2 — 데이터베이스

| 항목 | 내용 |
|---|---|
| 산출물 | `supabase/migrations/0001_init.sql`(확장·enum·테이블), `0002_rls.sql`, `0003_seed.sql`, `lib/db/types.ts` |
| 완료 조건 | 마이그레이션 2회 실행해도 오류 없음. anon 키로 미승인 이벤트 조회 시 0행 |
| 테스트 | RLS 누수 테스트(events/impacts/articles/steps/requirements 각각), enum ↔ Zod 대조 |

## Phase 3 — 뉴스 수집

| 항목 | 내용 |
|---|---|
| 산출물 | `lib/news/naver.ts`(rate limit·백오프), `normalize.ts`, `dedupe.ts`, `cluster.ts`, `app/api/cron/{collect,cluster}/route.ts` |
| 완료 조건 | 수집 2회 실행 시 행 수 증가 없음(멱등). 유사 기사 3건이 1 이벤트로 묶임 |
| 테스트 | 제목 정규화 / 동일뉴스 판별 / 서로 다른 사건 오분류 방지 / 중복 cron 차단 |

## Phase 4 — 이벤트 분석

| 항목 | 내용 |
|---|---|
| 산출물 | `lib/llm/{provider,openai,anthropic,schemas,cost}.ts`, `app/api/cron/analyze/route.ts`, 상태 머신 `lib/events/state.ts` |
| 완료 조건 | 픽스처로 P1·P2 파싱·검증 전 경로 통과. 실제 호출 1건으로 이벤트 생성 |
| 테스트 | 이벤트 JSON validation / 금지어 차단 / 재시도 / 예산 초과 정지 / 상태 전이 |

## Phase 5 — 기업 데이터 (Python)

| 항목 | 내용 |
|---|---|
| 산출물 | `python/dart/{corp_code,company,report}.py`, `python/profile/build.py`, `python/embed/backfill.py` |
| 완료 조건 | KOSPI+KOSDAQ 기업 마스터 적재. 상위 50사 프로필 자동 생성 + evidence 연결 |
| 테스트 | 발췌 원문 포함 검증 / exposure upsert 멱등성 |

## Phase 6 — 종목 매칭 엔진

| 항목 | 내용 |
|---|---|
| 산출물 | `lib/matching/{candidates,scoring,synonyms}.ts`, P3 호출, `event_impacts` 저장 |
| 완료 조건 | 이벤트 1건에 대해 긍정·부정·공급망·테마 그룹이 종목코드와 함께 생성 |
| 테스트 | **점수 계산 7항목 전부** / 미등록 종목 생성 방지 / 종목코드 누락 제외 / thematic 강등 / 39점 캡 / 긍정·부정 분류 |

## Phase 7 — 관리자 화면

| 항목 | 내용 |
|---|---|
| 산출물 | `/admin` 대시보드, `/admin/events/[id]` 검수 UI, 서버 액션(승인·반려·수정·재분석·공개취소), `/admin/companies/[id]` |
| 완료 조건 | 모든 수정이 `admin_reviews`에 diff와 함께 기록됨 |
| 테스트 | 비관리자 접근 차단(미들웨어+서버액션 이중) / 승인 전 공개 차단 |

## Phase 8 — 공개 화면

| 항목 | 내용 |
|---|---|
| 산출물 | `/`, `/events`, `/events/[id]`(9섹션), `/companies`, `/companies/[stockCode]`, `/about` |
| 완료 조건 | 모바일/데스크톱 정상. 점수 툴팁에 breakdown 표시. 근거 배지 4종 동작 |
| 테스트 | 미승인 이벤트 직접 URL 접근 시 404 |

## Phase 9 — 배포 준비

| 항목 | 내용 |
|---|---|
| 산출물 | `.github/workflows/cron.yml`, `vercel.json`, `README.md`, 운영 체크리스트 |
| 완료 조건 | Vercel 빌드 성공, cron이 `CRON_SECRET`으로 호출됨, 비용 상한 동작 |

---

## 구현 순서상의 위험 (착수 전 인지)

1. **Phase 5가 실질적 병목이다.** 기업 프로필 품질이 곧 제품 품질이다.
   프로필이 빈약하면 Phase 6이 아무리 정교해도 테마 종목만 나온다.
   → Phase 6 착수 전에 상위 50사만이라도 손검수된 프로필이 있어야 한다.
2. **Phase 3 클러스터링은 과하게 묶는 쪽이 더 위험하다.**
   서로 다른 사건이 한 이벤트로 합쳐지면 전파 경로 전체가 오염된다. 보수적으로.
3. **Phase 6 점수 함수는 실데이터 없이 튜닝하지 않는다.** 초기 가중치는 가설이며,
   실제 이벤트 20건을 관리자가 검수한 뒤 조정한다.
