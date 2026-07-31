import type { z } from 'zod';
import type { ModelTier, ProviderName } from './models';

/**
 * LLM 추상화.
 *
 * 파이프라인은 이 인터페이스만 본다. 특정 공급업체에 종속되지 않도록
 * 모델명·요청 형식·structured output 구현 방식은 전부 provider 안에 가둔다.
 */
export type LlmUsage = {
  inputTokens: number;
  outputTokens: number;
};

export type LlmResult<T> = {
  data: T;
  usage: LlmUsage;
  estimatedCostUsd: number;
  provider: ProviderName;
  model: string;
};

export type StructuredRequest<T> = {
  /** 출력 스키마. 위반 시 SchemaViolationError 를 던진다. */
  schema: z.ZodType<T>;
  /** 스키마 이름 (공급업체 API 가 요구하는 식별자) */
  schemaName: string;
  system: string;
  user: string;
  tier: ModelTier;
  maxOutputTokens?: number;
};

export interface LlmProvider {
  readonly name: ProviderName;
  structured<T>(request: StructuredRequest<T>): Promise<LlmResult<T>>;
  embed(texts: string[]): Promise<number[][]>;
}
