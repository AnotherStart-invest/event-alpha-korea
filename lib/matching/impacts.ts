import type { RelationType } from '@/lib/db/enums';
import { containsBannedPhrase } from '@/lib/shared/banned-words';
import type { ImpactJudgement } from '@/lib/llm/schemas';
import { applyHardRules, scoreCandidate } from './scoring';
import type { Candidate, EventQuery, ScoreBreakdown } from './types';

/**
 * 영향 판정 결과의 검증과 확정.
 *
 * ★ 이 파일이 제품 불변식 I1·I2·I4·I5 를 실제로 강제하는 지점이다.
 * 프롬프트가 아무리 잘 써져 있어도 여기서 걸러지지 않으면 의미가 없다.
 */

export type ValidatedImpact = {
  companyId: string;
  companyName: string;
  stockCode: string;
  impactDirection: ImpactJudgement['impact_direction'];
  impactLevel: ImpactJudgement['impact_level'];
  relationType: RelationType;
  relevanceScore: number;
  breakdown: ScoreBreakdown;
  /** 방향 판정을 건너뛴 경우 null (deriveImpacts) */
  confidenceScore: number | null;
  rationale: string;
  transmissionPath: string[];
  evidenceIds: string[];
  missingEvidence: string[];
  invalidationConditions: string[];
};

export type ValidationStats = {
  received: number;
  kept: number;
  droppedUnknownCompany: number;
  droppedNoStockCode: number;
  droppedBannedPhrase: number;
  demotedToThematic: number;
};

export type ValidationResult = {
  impacts: ValidatedImpact[];
  stats: ValidationStats;
};

/**
 * LLM 출력을 후보 집합과 대조해 정제한다.
 *
 * - 후보 목록에 없는 company_id 는 버린다 (I1: 존재하지 않는 종목 생성 방지)
 * - 종목코드가 없는 기업은 버린다 (I2)
 * - 제공되지 않은 evidence_id 는 제거한다 (I4)
 * - 근거가 부족하면 thematic 으로 강등하고 39점으로 캡한다 (I5)
 * - 금지 표현이 들어간 rationale 은 버린다
 *
 * 순수 함수다. droppedUnknownCompany 가 0 이 아니면 프롬프트나 후보 생성에
 * 문제가 있다는 신호이므로 반드시 로그로 남긴다.
 */
export function validateImpacts(
  judgements: ImpactJudgement[],
  candidates: Candidate[],
  query: EventQuery,
  now = new Date(),
): ValidationResult {
  const byId = new Map(candidates.map((c) => [c.companyId, c]));
  const allowedEvidence = new Set(
    candidates.flatMap((c) => c.exposures.map((e) => e.evidenceId).filter((id): id is string => id !== null)),
  );

  const stats: ValidationStats = {
    received: judgements.length,
    kept: 0,
    droppedUnknownCompany: 0,
    droppedNoStockCode: 0,
    droppedBannedPhrase: 0,
    demotedToThematic: 0,
  };

  const impacts: ValidatedImpact[] = [];
  const seen = new Set<string>();

  for (const judgement of judgements) {
    const candidate = byId.get(judgement.company_id);

    // I1 — 후보 밖의 기업은 존재하지 않는 것으로 취급한다
    if (!candidate) {
      stats.droppedUnknownCompany++;
      continue;
    }
    if (seen.has(candidate.companyId)) continue;

    // 금지 표현 검사
    const texts = [judgement.rationale, ...judgement.transmission_path, ...judgement.invalidation_conditions];
    if (texts.some((t) => containsBannedPhrase(t))) {
      stats.droppedBannedPhrase++;
      continue;
    }

    // I4 — 제공하지 않은 근거 id 는 지어낸 것이므로 제거
    const evidenceIds = judgement.evidence_ids.filter((id) => allowedEvidence.has(id));

    const breakdown = scoreCandidate(candidate, query, now);
    const ruled = applyHardRules(candidate, breakdown, judgement.relation_type, evidenceIds.length);

    // I2 — 종목코드 없는 기업은 공개 결과에 넣지 않는다
    if (ruled.excluded) {
      stats.droppedNoStockCode++;
      continue;
    }
    if (ruled.relationType === 'thematic' && judgement.relation_type !== 'thematic') {
      stats.demotedToThematic++;
    }

    seen.add(candidate.companyId);
    stats.kept++;
    impacts.push({
      companyId: candidate.companyId,
      companyName: candidate.companyName,
      stockCode: candidate.stockCode!,
      impactDirection: judgement.impact_direction,
      impactLevel: judgement.impact_level,
      relationType: ruled.relationType,
      relevanceScore: ruled.score,
      breakdown,
      confidenceScore: judgement.confidence_score,
      rationale: judgement.rationale,
      transmissionPath: judgement.transmission_path,
      evidenceIds,
      missingEvidence: judgement.missing_evidence,
      invalidationConditions: judgement.invalidation_conditions,
    });
  }

  impacts.sort((a, b) => b.relevanceScore - a.relevanceScore);
  return { impacts, stats };
}

/* ── LLM 없이 확정하기 ─────────────────────────────────── */

/** 노출 유형 → 관계 유형. 가장 강한 관계 하나를 고른다. */
const RELATION_BY_EXPOSURE: Record<string, RelationType> = {
  product: 'direct',
  raw_material: 'direct',
  commodity: 'direct',
  project: 'direct',
  subsidiary: 'direct',
  customer: 'supply_chain',
  customer_industry: 'supply_chain',
  supplier: 'supply_chain',
  competitor: 'competitor',
  substitute: 'substitute',
};
const RELATION_RANK: RelationType[] = ['direct', 'supply_chain', 'competitor', 'substitute', 'indirect', 'thematic'];

/**
 * **LLM 을 부르지 않고** 후보를 그대로 관련 종목으로 확정한다.
 *
 * 방향(긍정·부정)은 판정하지 않는다. 그건 원래 두 번째 LLM 호출이 하던 일인데,
 * 무료 티어에서 그걸 부르면 이벤트당 호출이 2배가 되어 하루 처리량이 반토막 난다.
 * "이 이벤트와 무엇이 겹치는가"까지는 노출 데이터만으로 정직하게 말할 수 있고,
 * "그래서 주가가 어느 쪽인가"는 말할 수 없으므로 uncertain 으로 남긴다.
 *
 * 점수·하드룰은 LLM 경로와 완전히 같은 함수를 쓴다. 두 경로의 점수가 달라지면
 * 같은 화면에 섞였을 때 비교가 불가능해진다.
 */
export function deriveImpacts(
  candidates: Candidate[],
  query: EventQuery,
  now = new Date(),
): ValidationResult {
  const stats: ValidationStats = {
    received: candidates.length,
    kept: 0,
    droppedUnknownCompany: 0,
    droppedNoStockCode: 0,
    droppedBannedPhrase: 0,
    demotedToThematic: 0,
  };

  const impacts: ValidatedImpact[] = [];

  for (const candidate of candidates) {
    const evidenceIds = Array.from(
      new Set(candidate.exposures.map((e) => e.evidenceId).filter((id): id is string => id !== null)),
    );
    const breakdown = scoreCandidate(candidate, query, now);
    const proposed = strongestRelation(candidate);
    const ruled = applyHardRules(candidate, breakdown, proposed, evidenceIds.length);

    if (ruled.excluded) {
      stats.droppedNoStockCode++;
      continue;
    }
    if (ruled.relationType === 'thematic' && proposed !== 'thematic') stats.demotedToThematic++;

    stats.kept++;
    impacts.push({
      companyId: candidate.companyId,
      companyName: candidate.companyName,
      stockCode: candidate.stockCode!,
      // 판정하지 않았다는 사실을 그대로 남긴다.
      impactDirection: 'uncertain',
      impactLevel: 'low',
      relationType: ruled.relationType,
      relevanceScore: ruled.score,
      breakdown,
      confidenceScore: null,
      rationale: describeMatch(candidate),
      transmissionPath: [],
      evidenceIds,
      missingEvidence: ['영향의 방향과 크기(실적 반영 규모)는 확인되지 않았습니다.'],
      invalidationConditions: [],
    });
  }

  impacts.sort((a, b) => b.relevanceScore - a.relevanceScore);
  return { impacts, stats };
}

function strongestRelation(candidate: Candidate): RelationType {
  let best: RelationType = 'thematic';
  for (const exposure of candidate.exposures) {
    const relation = RELATION_BY_EXPOSURE[exposure.exposureType];
    if (!relation) continue;
    if (RELATION_RANK.indexOf(relation) < RELATION_RANK.indexOf(best)) best = relation;
  }
  return best;
}

/** 왜 걸렸는지를 노출 데이터 그대로 쓴다. 해석을 덧붙이지 않는다. */
function describeMatch(candidate: Candidate): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const exposure of candidate.exposures) {
    const key = `${exposure.exposureType}:${exposure.exposureValue}`;
    if (seen.has(key)) continue;
    seen.add(key);
    parts.push(`${EXPOSURE_LABELS[exposure.exposureType] ?? exposure.exposureType} "${exposure.exposureValue}"`);
    if (parts.length >= 3) break;
  }
  const head = parts.length > 0 ? parts.join(', ') : '등록된 노출';
  return `${head} 이(가) 이 이벤트의 영향 범위와 겹칩니다. 영향의 방향과 크기는 판정하지 않았습니다.`;
}

const EXPOSURE_LABELS: Record<string, string> = {
  product: '주요제품',
  raw_material: '원재료',
  commodity: '원자재 노출',
  customer: '고객사',
  customer_industry: '고객 산업',
  supplier: '공급사',
  competitor: '경쟁사',
  substitute: '대체재',
  geography: '지역',
  subsidiary: '자회사',
  project: '주요 프로젝트',
  policy: '정책 노출',
};

/* ── 프롬프트 입력 구성 ────────────────────────────────── */

export type EvidenceForPrompt = {
  id: string;
  source_type: string;
  source_title: string;
  excerpt: string | null;
  source_date: string | null;
};

/**
 * LLM 에 넘길 후보 블록.
 * **여기에 들어간 기업과 근거만이 LLM 이 고를 수 있는 전부다.**
 */
export function buildCandidateBlock(
  candidates: Candidate[],
  evidence: Map<string, EvidenceForPrompt>,
): string {
  const blocks = candidates.map((candidate) => {
    const lines = [
      `[company_id=${candidate.companyId}] ${candidate.companyName} (${candidate.stockCode}, ${candidate.market ?? '시장미상'})`,
    ];
    if (candidate.industryName) lines.push(`  업종: ${candidate.industryName}`);

    lines.push('  매칭된 노출:');
    for (const exposure of candidate.exposures.slice(0, 8)) {
      const bits = [`${exposure.exposureType} "${exposure.exposureValue}"`];
      if (exposure.revenueShare !== null) bits.push(`revenue_share=${exposure.revenueShare}`);
      if (exposure.geography) bits.push(`geography=${exposure.geography}`);
      if (exposure.evidenceId) bits.push(`evidence_id=${exposure.evidenceId}`);
      lines.push(`    - ${bits.join(', ')}`);
    }

    const evidenceIds = Array.from(
      new Set(candidate.exposures.map((e) => e.evidenceId).filter((id): id is string => id !== null)),
    );
    if (evidenceIds.length > 0) {
      lines.push('  근거:');
      for (const id of evidenceIds.slice(0, 6)) {
        const ev = evidence.get(id);
        if (!ev) continue;
        const date = ev.source_date ?? '날짜미상';
        const excerpt = (ev.excerpt ?? '').replace(/\s+/g, ' ').slice(0, 200);
        lines.push(`    [${id}] ${ev.source_type} ${ev.source_title} ${date} "${excerpt}"`);
      }
    } else {
      lines.push('  근거: 없음');
    }

    return lines.join('\n');
  });

  return `=== 후보 기업 ${candidates.length}개 ===\n${blocks.join('\n')}\n=== 후보 끝 ===`;
}

export function buildImpactUser(
  event: {
    title: string;
    factualSummary: string | null;
    primaryVariable: string | null;
    variableDirection: string;
    geography: string[];
    transmissionChain: string[];
  },
  candidates: Candidate[],
  evidence: Map<string, EvidenceForPrompt>,
): string {
  const chain = event.transmissionChain.map((step, i) => `  ${i + 1}) ${step}`).join('\n');
  return [
    '=== 이벤트 ===',
    `제목: ${event.title}`,
    `사실요약: ${event.factualSummary ?? '(없음)'}`,
    `핵심변수: ${event.primaryVariable ?? '(없음)'} (${event.variableDirection})`,
    '전파경로:',
    chain || '  (없음)',
    `지역: ${event.geography.join(', ') || '(없음)'}`,
    '',
    buildCandidateBlock(candidates, evidence),
  ].join('\n');
}

/** P3 는 배치당 40개까지만 보낸다. 그래야 입력이 커지지 않고 판정 품질이 유지된다. */
export const IMPACT_BATCH_SIZE = 40;

export function chunkCandidates(candidates: Candidate[], size = IMPACT_BATCH_SIZE): Candidate[][] {
  const chunks: Candidate[][] = [];
  for (let i = 0; i < candidates.length; i += size) {
    chunks.push(candidates.slice(i, i + size));
  }
  return chunks;
}
