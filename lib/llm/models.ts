/**
 * 모델 레지스트리.
 *
 * 파이프라인 코드는 'cheap' / 'standard' 티어만 알고, 실제 모델명은 여기서만 정한다.
 * 공급업체를 바꿔도 이 파일과 각 provider 구현만 손대면 된다.
 *
 * 단가는 백만 토큰당 USD. 요금이 바뀌면 여기만 고친다.
 */
export type ModelTier = 'cheap' | 'standard';
export type ProviderName = 'anthropic' | 'openai' | 'gemini';

/** 임베딩을 제공하는 공급업체. Anthropic 은 임베딩 API 가 없다. */
export type EmbeddingProviderName = Exclude<ProviderName, 'anthropic'>;

export type ModelSpec = {
  id: string;
  inputPerMTok: number;
  outputPerMTok: number;
  /** effort / adaptive thinking 파라미터를 받는 모델인지 */
  supportsEffort: boolean;
};

export const MODELS: Record<ProviderName, Record<ModelTier, ModelSpec>> = {
  anthropic: {
    // Haiku 4.5 는 effort / adaptive thinking 을 지원하지 않는다. 보내면 에러가 난다.
    cheap: { id: 'claude-haiku-4-5', inputPerMTok: 1.0, outputPerMTok: 5.0, supportsEffort: false },
    standard: { id: 'claude-sonnet-5', inputPerMTok: 3.0, outputPerMTok: 15.0, supportsEffort: true },
  },
  openai: {
    cheap: { id: 'gpt-5-mini', inputPerMTok: 0.25, outputPerMTok: 2.0, supportsEffort: false },
    standard: { id: 'gpt-5', inputPerMTok: 1.25, outputPerMTok: 10.0, supportsEffort: false },
  },
  // 무료 티어(AI Studio)로 쓸 수 있지만 단가는 **유료 기준**을 적어둔다.
  // 0 으로 적으면 llm_calls 비용이 전부 0 이 되어 일일 예산 상한이 무력화되고,
  // 나중에 결제를 켜는 순간 안전장치 없이 과금된다.
  // 무료 티어의 진짜 제약은 금액이 아니라 요청 수이고, 넘기면 과금이 아니라 429 가 온다.
  //
  // ⚠️ 2.5 계열(gemini-2.5-flash, -flash-lite)은 ListModels 에는 보이지만
  //    신규 사용자에게는 404 다("no longer available to new users").
  //    목록에 있다고 쓸 수 있는 게 아니므로 모델을 바꿀 때는 반드시 실호출로 확인할 것.
  //    → scripts/gemini-smoke.mjs
  gemini: {
    cheap: { id: 'gemini-3.1-flash-lite', inputPerMTok: 0.25, outputPerMTok: 1.5, supportsEffort: false },
    standard: { id: 'gemini-3.5-flash', inputPerMTok: 1.5, outputPerMTok: 9.0, supportsEffort: false },
  },
};

export type EmbeddingSpec = {
  id: string;
  /** DB 가 vector(1536) 이므로 공급업체가 무엇이든 1536 이어야 한다. */
  dimensions: number;
  perMTok: number;
};

export const EMBEDDING_MODELS: Record<EmbeddingProviderName, EmbeddingSpec> = {
  openai: { id: 'text-embedding-3-small', dimensions: 1536, perMTok: 0.02 },
  // gemini-embedding-001 은 출력 차원을 고를 수 있다. 1536 으로 맞춰야 스키마와 호환된다.
  gemini: { id: 'gemini-embedding-001', dimensions: 1536, perMTok: 0.15 },
};

/** 기본 임베딩 모델. 공급업체별 선택은 EMBEDDING_MODELS 를 쓴다. */
export const EMBEDDING_MODEL = EMBEDDING_MODELS.openai;

export function estimateCostUsd(
  spec: ModelSpec,
  usage: { inputTokens: number; outputTokens: number },
): number {
  return (
    (usage.inputTokens / 1_000_000) * spec.inputPerMTok +
    (usage.outputTokens / 1_000_000) * spec.outputPerMTok
  );
}
