# Event Alpha Korea — LLM 프롬프트 설계 (LLM_PROMPTS)

> 문서 버전 0.1 · 2026-07-31 · Phase 0 산출물

---

## 0. 원칙

1. **LLM은 종목명을 만들지 않는다.** 기업명을 출력할 수 있는 필드를 스키마에 두지 않는다.
   유일한 예외는 P3이며, 거기서도 `company_id`만 고르게 하고 이름은 참고용 입력이다.
2. **프롬프트 지시는 보조 장치다.** 모든 제약은 Zod 스키마 + 코드 검증으로 이중 강제한다.
3. **사실과 추론을 필드로 분리한다.** `factual_summary`(기사에 있는 것) /
   `transmission_chain`(추론). 프롬프트에서 섞지 말라고 지시하고, 저장·렌더도 분리한다.
4. **모르면 `unknown`/`uncertain`.** 빈 문자열이나 그럴듯한 추측을 금지한다.
5. 온도 0, `max_output_tokens` 명시, JSON Schema strict 모드.

호출은 4종뿐이다.

| ID | 목적 | 모델 티어 | 입력 | 대략 비용/건 |
|---|---|---|---|---|
| P1 | 투자 관련성 사전필터 | cheap | 제목 1~5개 | ~$0.0002 |
| P2 | 이벤트 구조화 | standard | 클러스터 제목+요약 | ~$0.004 |
| P3 | 종목 영향 판정 | standard | 이벤트 + 후보 ≤40 | ~$0.01 |
| P4 | 기업 프로필 구조화 (Python) | standard | 사업보고서 섹션 | ~$0.01 |

---

## P1. 투자 관련성 사전필터

**목적**: 무관 기사를 값싼 모델로 걷어내 P2 비용을 줄인다. 클러스터 단위 1회.

### System

```
너는 한국 주식시장 리서치 보조 도구의 1차 분류기다.
주어진 뉴스 제목과 요약이 "국내 상장기업의 실적이나 사업환경에 영향을 줄 수 있는
구체적 사건"인지 판정한다.

관련 있음으로 분류할 사건 유형:
정책·규제, 관세·수출입 규제, 원자재 가격 변화, 공급망 중단, 공장 화재·생산 중단,
대규모 수주, 계약 체결·해지, M&A·경영권 변경, 자산 매각, 지정학·운송 차질

관련 없음으로 분류할 것:
주가·시황 보도, 증권사 리포트 요약, 개인 인터뷰, 스포츠·연예, 사건사고 일반,
이미 널리 알려진 사실의 재보도, 전망·칼럼·사설, 홍보성 보도자료.

판정 기준:
- 제목만으로 사건의 실체가 불분명하면 관련 없음으로 둔다. 추측하지 않는다.
- "예상", "전망", "관측" 같은 표현만 있고 확정 사실이 없으면 관련성을 낮춘다.
- 특정 기업 하나의 단순 홍보는 제외한다.
```

### User

```
제목: {titles}
요약: {descriptions}
발행: {published_at}
```

### 출력 스키마

```ts
z.object({
  is_investment_relevant: z.boolean(),
  event_type: z.enum([...EVENT_TYPES]).nullable(),
  confidence: z.number().int().min(0).max(100),
  reason: z.string().max(200),
})
```

### 후처리
- `is_investment_relevant=false` 또는 `confidence < 50` → 이벤트 `status='rejected'`, P2 미호출
- 이 단계 결과는 `events.last_error`가 아니라 `admin_reviews`에 `action='auto_filtered'`로 남겨
  관리자가 오탈락을 검토할 수 있게 한다

---

## P2. 이벤트 구조화

**목적**: 클러스터 → 구조화된 이벤트 + 전파 경로 + 확인 항목. **기업명은 출력하지 않는다.**

### System

```
너는 한국 주식시장 이벤트 드리븐 리서치 분석가다.
여러 언론사가 보도한 동일 사건의 제목과 요약을 받아 구조화된 분석을 만든다.

절대 규칙
1. 기사에 없는 사실을 쓰지 않는다. 기억에 의존한 배경 지식을 사실처럼 서술하지 않는다.
2. 사실과 추론을 분리한다. factual_summary에는 기사에 명시된 내용만 쓴다.
   transmission_chain에는 경제 논리에 따른 추론을 쓰되, 각 단계를 검증 가능한 문장으로 쓴다.
3. 개별 기업명, 종목명, 종목코드를 어떤 필드에도 쓰지 않는다.
   기업은 별도 데이터베이스 검색으로 찾는다. 산업, 제품, 원재료, 고객군, 지역 수준으로만 서술한다.
4. 불명확하면 unknown 또는 빈 배열을 쓴다. 그럴듯하게 채우지 않는다.
5. 매수, 매도, 목표주가, 진입가, 수익률, 상승 전망을 쓰지 않는다.
6. 제목만 있고 요약이 없으면 event_confidence를 60 이하로 둔다.
7. 출처가 서로 다른 언론사 3곳 이상에서 같은 사실을 보도하면 confidence를 높인다.
   다만 같은 통신사 기사를 전재한 것으로 보이면 출처 수를 신뢰의 근거로 삼지 않는다.

필드 작성 지침
- event_title: 사건을 한 줄로. 자극적 표현 금지.
- factual_summary: 3문장 이내. 확정 사실만.
- primary_variable: 이 사건이 바꾸는 경제 변수 하나.
  예) "미국 내 중국산 변압기 수입가격", "국제 구리 현물가격", "국내 전력망 투자 예산"
- variable_direction: 그 변수가 오르는지 내리는지.
- transmission_chain: 3~6단계. 각 단계는 한 문장.
  변수 변화 → 시장 구조 변화 → 특정 유형 기업의 손익 영향 순서로 쓴다.
- affected_products / affected_raw_materials: 데이터베이스 검색어로 쓸 것이므로
  일반 명사 형태로 쓴다. 예) "변압기", "구리", "해상풍력 하부구조물"
- affected_customer_groups: 이 사건의 영향을 받는 수요처 산업.
- required_evidence: 실제로 확인해야 숫자로 검증되는 항목. 예) "북미 매출 비중", "수주잔고"
- invalidation_conditions: 이 가설이 틀리게 되는 구체적 조건.
- follow_up_events: 앞으로 확인할 공시, 정책 발표, 데이터 공개 일정.
- novelty_score: 이미 시장에 알려진 사안이면 낮게. 처음 보도되는 사안이면 높게.
```

### User

```
=== 기사 {n}건 (동일 사건으로 묶임) ===
[1] {source_name} · {published_at}
    제목: {title}
    요약: {description}
[2] ...
```

### 출력 스키마

```ts
const EventStructure = z.object({
  is_investment_relevant: z.boolean(),
  event_title: z.string().min(5).max(120),
  factual_summary: z.string().max(600),
  event_type: z.enum([...EVENT_TYPES]),
  primary_variable: z.string().max(120),
  variable_direction: z.enum(['up','down','mixed','unknown']),
  geography: z.array(z.string().max(40)).max(8),
  affected_industries: z.array(z.string().max(40)).max(10),
  affected_products: z.array(z.string().max(40)).max(15),
  affected_raw_materials: z.array(z.string().max(40)).max(10),
  affected_customer_groups: z.array(z.string().max(40)).max(10),
  transmission_chain: z.array(z.string().max(200)).min(2).max(6),
  time_horizon: z.enum(['immediate','short','mid','long','unknown']),
  required_evidence: z.array(z.string().max(120)).max(10),
  invalidation_conditions: z.array(z.string().max(160)).max(8),
  follow_up_events: z.array(z.string().max(120)).max(8),
  event_confidence: z.number().int().min(0).max(100),
  novelty_score: z.number().int().min(0).max(100),
});
```

### 후처리 검증 (코드)

```
V1  금지어 린트: 모든 문자열 필드에 BANNED_WORDS 포함 시 → 재시도 1회, 실패 시 failed
V2  기업명 누출 검사: companies.company_name 중 길이 3자 이상인 이름이
    factual_summary/transmission_chain에 나타나면 로그 경고(차단은 아님, 기사 원문 인용일 수 있음)
V3  검색어 배열이 전부 비었으면 → status='failed', 관리자 큐로
V4  event_confidence < 40 → 자동 승인 큐에서 제외, 관리자 검토 우선순위 낮춤
```

---

## P3. 종목 영향 판정 (가장 중요)

**목적**: 코드가 뽑은 후보 기업들에 대해 방향·강도·관계유형·근거를 판정.

> **입력 통제가 이 프롬프트의 핵심이다.** 후보 기업 목록 밖의 정보를 주지 않는다.
> 배치 크기는 후보 40개씩. 100개면 3회 나눠 호출한다.

### System

```
너는 이벤트가 개별 기업에 미치는 영향을 판정하는 분석가다.

입력으로 하나의 이벤트와, 데이터베이스에서 검색된 후보 기업 목록을 받는다.
각 후보에는 그 기업이 왜 검색되었는지를 보여주는 노출 정보(exposure)와
그 노출의 근거(evidence)가 함께 주어진다.

절대 규칙
1. 주어진 후보 목록에 없는 기업을 출력하지 않는다. company_id는 반드시 입력에 있는 값이어야 한다.
2. 기업명을 새로 만들거나 기억에 의존해 다른 기업을 추가하지 않는다.
3. evidence_ids에는 그 기업에 대해 입력으로 제공된 evidence id만 쓴다.
4. 근거(evidence)가 제공되지 않은 기업은 relation_type을 반드시 thematic으로 한다.
5. 판단이 서지 않으면 impact_direction을 uncertain으로 한다. 억지로 positive/negative를 고르지 않는다.
6. 매수, 매도, 목표주가, 주가 전망을 쓰지 않는다. 손익과 사업 영향만 서술한다.
7. rationale은 반드시 입력에 있는 exposure를 근거로 든다.
   "관련이 있어 보인다" 같은 서술을 쓰지 않는다.
8. 이 사건으로 손해를 보는 기업도 반드시 찾는다. 긍정만 나열하지 않는다.
   비용이 오르는 기업, 경쟁이 심해지는 기업, 대체재에 밀리는 기업을 검토한다.

relation_type 기준
- direct: 이 기업의 제품/서비스 매출이 직접 변한다
- supply_chain: 이 기업의 고객사나 공급사가 영향을 받아 2차로 전달된다
- competitor: 경쟁 관계 변화로 반사 영향을 받는다
- substitute: 대체재 관계로 수요가 이동한다
- indirect: 위 어디에도 명확히 속하지 않으나 사업 영향 경로가 설명된다
- thematic: 키워드나 산업분류상 관련될 뿐 매출·고객·지역 근거가 없다

impact_level 기준
- high: 해당 사업이 매출의 상당 부분이고 영향 방향이 명확
- medium: 사업 일부이거나 영향 크기가 불확실
- low: 영향이 있어도 실적에 유의미하지 않을 가능성

missing_evidence에는 이 판단을 확정하려면 무엇을 더 확인해야 하는지 쓴다.
```

### User

```
=== 이벤트 ===
제목: {event_title}
사실요약: {factual_summary}
핵심변수: {primary_variable} ({variable_direction})
전파경로:
  1) …
  2) …
지역: {geography}

=== 후보 기업 {k}개 ===
[company_id=uuid-1] 삼성전자 (005930, KOSPI)
  업종: 반도체와반도체장비
  매칭된 노출:
    - product "메모리반도체" (revenue_share=52.0, evidence_id=ev-1)
    - geography "미국" (revenue_share=31.4, evidence_id=ev-2)
  근거:
    [ev-1] DART 사업보고서 2026-03-15 "…발췌 2문장…"
    [ev-2] DART 사업보고서 2026-03-15 "…발췌…"
[company_id=uuid-2] …
```

### 출력 스키마

```ts
const ImpactJudgement = z.object({
  company_id: z.string().uuid(),
  impact_direction: z.enum(['positive','negative','mixed','uncertain']),
  impact_level: z.enum(['high','medium','low']),
  relation_type: z.enum(['direct','indirect','supply_chain','competitor','substitute','thematic']),
  confidence_score: z.number().int().min(0).max(100),
  rationale: z.string().min(20).max(400),
  transmission_path: z.array(z.string().max(160)).max(4),
  evidence_ids: z.array(z.string().uuid()).max(6),
  missing_evidence: z.array(z.string().max(120)).max(5),
  invalidation_conditions: z.array(z.string().max(160)).max(4),
});
const ImpactBatch = z.object({ impacts: z.array(ImpactJudgement).max(40) });
```

> `relevance_score`는 **LLM이 정하지 않는다.** 코드의 `scoring.ts`가 계산한다.
> LLM이 낸 것은 `confidence_score`뿐이며, 이것도 최종 점수에 직접 더해지지 않는다.

### 후처리 검증 (코드) — I1·I4 강제 지점

```ts
const allowedCompanies = new Set(candidates.map(c => c.id));
const allowedEvidence  = new Set(candidates.flatMap(c => c.evidenceIds));

let out = batch.impacts
  .filter(i => allowedCompanies.has(i.company_id))        // 후보 밖 기업 제거
  .map(i => ({ ...i, evidence_ids: i.evidence_ids.filter(e => allowedEvidence.has(e)) }))
  .filter(i => companyById(i.company_id).stock_code !== null);   // R1

out = out.map(i => {
  const s = scoreCandidate(candidateOf(i.company_id), event);    // 순수 함수
  let relation = i.relation_type;
  if (i.evidence_ids.length === 0) relation = 'thematic';        // R3
  if (s.disclosure === 0 && s.revenue === 0) relation = 'thematic';
  const score = relation === 'thematic' ? Math.min(s.total, 39) : s.total;  // R2
  return { ...i, relation_type: relation, relevance_score: score, score_breakdown: s };
});

out = out.filter(i => !containsBannedWord(i.rationale));
```

**드랍된 항목은 반드시 로그와 `pipeline_runs.stats`에 기록한다.**
`dropped_unknown_company` 카운터가 0이 아니면 프롬프트나 후보 생성에 문제가 있다는 신호다.

---

## P4. 기업 프로필 구조화 (Python 배치)

**목적**: DART 사업보고서 "사업의 내용" 섹션 → `company_exposures` 행.

> 원문 전체를 한 번에 넣지 않는다. 섹션 추출 → 8k자 단위 청크 → 청크별 호출 → 병합.

### System

```
너는 한국 상장기업의 사업보고서에서 구조화된 사업 노출 정보를 추출한다.

절대 규칙
1. 주어진 본문에 명시된 내용만 추출한다. 일반 상식이나 기억으로 보완하지 않는다.
2. 각 항목마다 근거가 된 원문 문장을 evidence_excerpt에 그대로 옮긴다. 2문장 이내로 자른다.
3. 원문에 없으면 그 필드를 비운다. 추정하지 않는다.
4. 비율(매출 비중 등)은 본문에 숫자가 명시된 경우에만 채운다.
5. 제품명, 원재료명, 지역명은 검색어로 쓰이므로 일반 명사 형태로 정규화한다.
   예) "당사의 주력 제품인 초고압 변압기" → "초고압 변압기"

추출 대상 exposure_type
product, raw_material, customer, customer_industry, geography, supplier,
subsidiary, project, competitor, substitute, positive_variable, negative_variable

positive_variable / negative_variable 은 본문에서 "…가 상승하면 수익성이 개선"
같이 명시적으로 서술된 민감 변수만 추출한다.
```

### 출력 스키마

```ts
z.object({
  exposures: z.array(z.object({
    exposure_type: z.enum([...EXPOSURE_TYPES]),
    exposure_value: z.string().max(80),
    revenue_share: z.number().min(0).max(100).nullable(),
    geography: z.string().max(40).nullable(),
    direction: z.enum(['up','down','mixed','unknown']).nullable(),
    evidence_excerpt: z.string().max(400),
  })).max(60),
  business_summary: z.string().max(500),
})
```

### 후처리
- `evidence_excerpt`가 원문에 실제로 포함되는지 **부분 문자열 검사**. 불일치하면 그 항목 폐기
  (LLM이 문장을 지어냈다는 뜻이므로 가장 신뢰도 높은 검증 장치다)
- `evidence_sources` 행 생성 후 `company_exposures.source_evidence_id`로 연결
- `verified=false`로 저장. 관리자가 확인해야 `true`

---

## 6. 재시도·실패 정책

| 상황 | 처리 |
|---|---|
| JSON 파싱/스키마 실패 | 동일 프롬프트 1회 재시도 → 실패 시 `status='failed'` |
| 금지어 검출 | "금지 표현을 제거하고 다시 작성" 지시 붙여 1회 재시도 |
| 429 / 5xx | 지수 백오프 3회 (1s, 4s, 16s) |
| 예산 초과 | 즉시 중단. 이벤트는 `candidate`로 되돌려 다음날 처리 |
| `retry_count >= 3` | 관리자 큐로. 자동 재시도 중단 |

## 7. 테스트 픽스처

`tests/fixtures/` 에 실제 호출 없이 검증 가능한 고정 입출력을 둔다.

- `event_structure_valid.json` — 정상 케이스
- `event_structure_with_company_name.json` — 기업명 누출 → V2 경고 확인
- `event_structure_banned_word.json` — "목표주가" 포함 → V1 차단 확인
- `impact_unknown_company.json` — 후보에 없는 uuid → 필터링 확인
- `impact_no_evidence.json` — evidence 없음 → thematic 강등 + 39점 캡 확인
- `impact_no_stock_code.json` — 비상장 → 제외 확인
- `profile_hallucinated_excerpt.json` — 원문에 없는 발췌 → 폐기 확인
