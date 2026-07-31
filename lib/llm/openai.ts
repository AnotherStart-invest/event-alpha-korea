import 'server-only';
import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import { required } from '@/lib/shared/env';
import { SchemaViolationError, UpstreamError, withRetry } from '@/lib/shared/errors';
import { EMBEDDING_MODEL, MODELS, estimateCostUsd } from './models';
import type { LlmProvider, LlmResult, StructuredRequest } from './provider';

/**
 * OpenAI 구현. Responses API 의 structured output 을 사용한다.
 * 임베딩은 공급업체 설정과 무관하게 항상 이 provider 를 쓴다.
 */
export function createOpenAiProvider(): LlmProvider {
  const client = new OpenAI({ apiKey: required('OPENAI_API_KEY') });

  return {
    name: 'openai',

    async structured<T>(request: StructuredRequest<T>): Promise<LlmResult<T>> {
      const spec = MODELS.openai[request.tier];

      const response = await withRetry(async () => {
        try {
          return await client.responses.parse({
            model: spec.id,
            input: [
              { role: 'system', content: request.system },
              { role: 'user', content: request.user },
            ],
            max_output_tokens: request.maxOutputTokens ?? 4096,
            text: { format: zodTextFormat(request.schema, request.schemaName) },
          });
        } catch (err) {
          throw toUpstream(err);
        }
      });

      const parsed = response.output_parsed;
      if (parsed === null || parsed === undefined) {
        throw new SchemaViolationError('LLM 응답이 스키마를 만족하지 못했습니다.');
      }

      const usage = {
        inputTokens: response.usage?.input_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
      };

      return {
        data: parsed as T,
        usage,
        estimatedCostUsd: estimateCostUsd(spec, usage),
        provider: 'openai',
        model: spec.id,
      };
    },

    async embed(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) return [];

      const response = await withRetry(async () => {
        try {
          return await client.embeddings.create({
            model: EMBEDDING_MODEL.id,
            input: texts,
            dimensions: EMBEDDING_MODEL.dimensions,
          });
        } catch (err) {
          throw toUpstream(err);
        }
      });

      // API 는 index 순서를 보장하지 않으므로 정렬한다.
      return [...response.data]
        .sort((a, b) => a.index - b.index)
        .map((item) => item.embedding);
    },
  };
}

function toUpstream(err: unknown): unknown {
  if (err instanceof OpenAI.APIError) {
    return new UpstreamError(`OpenAI API 오류: ${err.message}`, err.status ?? 500);
  }
  return err;
}
