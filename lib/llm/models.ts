/**
 * 모델 레지스트리.
 *
 * 파이프라인 코드는 'cheap' / 'standard' 티어만 알고, 실제 모델명은 여기서만 정한다.
 * 공급업체를 바꿔도 이 파일과 각 provider 구현만 손대면 된다.
 *
 * 단가는 백만 토큰당 USD. 요금이 바뀌면 여기만 고친다.
 */
export type ModelTier = 'cheap' | 'standard';
export type ProviderName = 'anthropic' | 'openai';

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
};

export const EMBEDDING_MODEL = {
  id: 'text-embedding-3-small',
  dimensions: 1536,
  perMTok: 0.02,
};

export function estimateCostUsd(
  spec: ModelSpec,
  usage: { inputTokens: number; outputTokens: number },
): number {
  return (
    (usage.inputTokens / 1_000_000) * spec.inputPerMTok +
    (usage.outputTokens / 1_000_000) * spec.outputPerMTok
  );
}
