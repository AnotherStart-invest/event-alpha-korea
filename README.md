# Event Alpha Korea

국내 뉴스에서 투자 관련 이벤트를 자동 추출하고, 경제적 전파 경로를 따라
**근거가 있는 국내 상장 종목**을 연결하는 리서치 지원 도구.

> 투자자문·투자권유가 아닙니다. 매수·매도·목표주가를 제공하지 않습니다.

## 이 제품의 핵심

AI가 종목을 **지어내지 못하게** 하는 것이 설계의 중심이다.

```
뉴스 → 중복 제거 → 이벤트 구조화(LLM, 기업명 출력 불가)
     → 기업 DB 검색(결정론적, LLM 미개입)
     → 영향 판정(LLM, 후보 목록 안에서만)
     → 코드가 집합 멤버십 검증 + 점수 계산
     → 관리자 승인 → 공개
```

강제 지점:

| 불변식 | 강제 위치 |
|---|---|
| 후보 밖 기업 출력 차단 | [`lib/matching/impacts.ts`](lib/matching/impacts.ts) `validateImpacts` |
| 종목코드 없는 기업 제외 | 같은 함수 + `companies_public_read` RLS |
| 근거 없으면 thematic 강등·39점 캡 | [`lib/matching/scoring.ts`](lib/matching/scoring.ts) `applyHardRules` |
| 승인 전 공개 차단 | [`supabase/migrations/0002_rls.sql`](supabase/migrations/0002_rls.sql) |
| 기사 본문 미저장 | 스키마에 body 컬럼 없음 |
| 금지 표현 차단 | [`lib/shared/banned-words.ts`](lib/shared/banned-words.ts) |
| 발췌문 조작 차단 | [`python/scripts/build_profiles.py`](python/scripts/build_profiles.py) `excerpt_is_grounded` |

설계 문서는 [`docs/`](docs) 참고.

---

## 실행 방법

### 0. 사전 준비

| 항목 | 발급처 |
|---|---|
| Supabase 프로젝트 | https://supabase.com |
| 네이버 검색 API (NAVER API HUB) | https://www.ncloud.com/product/applicationService/naverApiHub |
| OpenDART 인증키 | https://opendart.fss.or.kr |
| Anthropic 또는 OpenAI 키 | 각 콘솔 |

Node 20.9+, Python 3.11+ 필요.

### 1. 설치

```bash
npm install
```

```bash
python -m venv .venv && .venv\Scripts\activate && pip install -r python/requirements.txt
```

### 2. 환경변수

```bash
cp .env.example .env.local
```

`.env.local` 을 채운다. `CRON_SECRET` 은 아래로 생성:

```bash
openssl rand -hex 32
```

### 3. 데이터베이스

Supabase SQL Editor에서 순서대로 실행한다.

1. `supabase/migrations/0001_init.sql`
2. `supabase/migrations/0002_rls.sql`
3. `supabase/migrations/0003_seed.sql`

전부 재실행 가능하다(idempotent).

Supabase CLI를 쓴다면:

```bash
npx supabase db push
```

### 4. 기업 데이터 적재

```bash
python -m python.scripts.sync_companies
```

```bash
python -m python.scripts.build_profiles --limit 50
```

```bash
python -m python.scripts.backfill_embeddings
```

> `build_profiles` 는 LLM 비용이 발생한다. `--dry-run` 으로 먼저 확인할 것.
> **기업 프로필이 없으면 관련 종목을 하나도 찾지 못한다.** 이것이 제품 품질의 상한이다.

### 5. 개발 서버

```bash
npm run dev
```

### 6. 관리자 계정

1. http://localhost:3000/admin/login 에서 `ADMIN_EMAIL` 로 로그인 (매직링크)
2. 권한 승격:

```bash
python -m python.scripts.bootstrap_admin
```

### 7. 파이프라인 실행

`/admin` 의 버튼으로 수동 실행하거나:

```bash
curl -X POST http://localhost:3000/api/cron/collect
```

```bash
curl -X POST http://localhost:3000/api/cron/cluster
```

```bash
curl -X POST http://localhost:3000/api/cron/analyze
```

> 개발 환경에서는 `CRON_SECRET` 없이도 통과한다. 운영에서는 반드시 필요하다.

---

## 검증

```bash
npm run check
```

`typecheck` + `lint` + `test` 를 한 번에 돌린다.

테스트는 외부 API 없이 순수 함수만 검증한다.

| 파일 | 검증 대상 |
|---|---|
| `tests/normalize.test.ts` | 제목 정규화, 동일 뉴스 판별 |
| `tests/cluster.test.ts` | 서로 다른 사건 오분류 방지 |
| `tests/scoring.test.ts` | 관련도 점수 7개 항목, 하드 룰 |
| `tests/impacts.test.ts` | 미등록 종목 차단, thematic 강등, 긍정·부정 분류 |
| `tests/event-state.test.ts` | 승인 전 공개 차단 |
| `tests/pipeline-run.test.ts` | 중복 cron 실행 방지 |
| `tests/banned-words.test.ts` | 금지 표현 린트 |

---

## 배포

### Vercel

1. 저장소를 Vercel에 연결
2. 환경변수를 전부 등록 (`.env.example` 참고)
3. 배포

### cron

Vercel Hobby의 cron은 **하루 1회**가 최대다. 5~15분 주기는 GitHub Actions로 돌린다.

저장소 Secrets에 등록:

| 이름 | 값 |
|---|---|
| `APP_URL` | `https://your-app.vercel.app` |
| `CRON_SECRET` | `.env.local` 과 동일한 값 |

`.github/workflows/cron.yml` 이 15분마다 세 엔드포인트를 호출한다.

---

## 운영 체크리스트

- [ ] `/admin` 상단에 파이프라인 경고 배너가 없는가 (60분 이상 미실행 시 표시)
- [ ] 오늘 LLM 비용이 상한 아래인가 (`app_settings.daily_llm_budget_usd`, 기본 $3)
- [ ] `pipeline_runs` 에 `ok=false` 가 누적되고 있지 않은가
- [ ] `dropped_unknown_company` 경고 로그가 나오지 않는가 — 나오면 프롬프트나 후보 생성에 문제가 있다
- [ ] anon 키로 미승인 이벤트를 조회했을 때 0행인가
- [ ] 기업 프로필 커버리지가 늘고 있는가

### 비용 통제

| 장치 | 위치 |
|---|---|
| 중복 기사 사전 제거 | `lib/news/collect.ts` |
| 저비용 사전필터 | `lib/events/analyze.ts` (P1) |
| 동일 이벤트 재분석 금지 | 관리자 명시 요청 시에만 |
| tick당 처리 상한 | `app_settings.max_events_per_tick` |
| 일일 예산 상한 | `lib/llm/index.ts` `assertWithinBudget` |
| 호출별 비용 기록 | `llm_calls` 테이블 |

예상 비용은 하루 약 $1.3 (월 $40). 줄여야 하면 P3의 후보 배치 크기(40)를 낮추는 것이 가장 효과가 크다.

### 보안 점검

- [ ] `SUPABASE_SERVICE_ROLE_KEY` 가 클라이언트 번들에 없는가 (`server-only` 로 차단 중)
- [ ] `/api/cron/*` 이 `CRON_SECRET` 없이 401을 반환하는가 (운영 환경)
- [ ] 서버 액션이 `requireAdmin()` 으로 시작하는가 — proxy만 믿지 않는다
- [ ] `.env*` 가 커밋되지 않았는가

---

## 구조

```
app/            공개 페이지 + 관리자 + cron 라우트
lib/
  db/           Supabase 클라이언트 3종, 타입, enum
  news/         수집·정규화·클러스터링
  llm/          provider 추상화, 스키마, 프롬프트
  matching/     후보 생성, 점수 계산, 영향 검증  ← 제품의 핵심
  events/       상태 머신, 분석 오케스트레이션
  queries/      화면용 조회
  admin/        서버 액션
python/         OpenDART 수집, 기업 프로필 생성, 임베딩 백필
supabase/       마이그레이션
tests/          순수 함수 테스트
docs/           설계 문서 6종
```

## 알려진 한계

[`docs/RISK_AND_LIMITATIONS.md`](docs/RISK_AND_LIMITATIONS.md) 에 정리되어 있다. 요약:

- 기업 프로필에 없는 관계는 절대 못 찾는다 — 커버리지가 곧 상한
- 사업보고서는 연 1회 갱신이라 최근 변화 반영이 늦다
- 시세를 쓰지 않으므로 "이미 주가에 반영됐는지"는 판단 불가
- 한국어 형태소 분석기가 없어 동의어 사전 품질에 매칭이 좌우된다
- MVP는 외부 공개 없이 본인 사용으로 한정
