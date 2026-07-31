import 'server-only';
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { required } from '@/lib/shared/env';
import { SchemaViolationError, UpstreamError, withRetry } from '@/lib/shared/errors';
import { MODELS, estimateCostUsd } from './models';
import type { LlmProvider, LlmResult, StructuredRequest } from './provider';

/**
 * Anthropic 구현.
 *
 * structured output 은 `messages.parse()` + `output_config.format` 을 쓴다.
 * 스키마를 만족하지 못하면 parsed_output 이 null 이므로 그때 예외를 던진다.
 *
 * 주의: Sonnet 5 / Opus 계열은 temperature·top_p·top_k 를 받지 않는다(400).
 * Haiku 4.5 는 effort 를 받지 않는다. 그래서 supportsEffort 로 분기한다.
 */
export function createAnthropicProvider(): LlmProvider {
  const client = new Anthropic({ apiKey: required('ANTHROPIC_API_KEY') });

  return {
    name: 'anthropic',

    async structured<T>(request: StructuredRequest<T>): Promise<LlmResult<T>> {
      const spec = MODELS.anthropic[request.tier];

      const response = await withRetry(async () => {
        try {
          return await client.messages.parse({
            model: spec.id,
            max_tokens: request.maxOutputTokens ?? 4096,
            system: request.system,
            messages: [{ role: 'user', content: request.user }],
            output_config: {
              format: zodOutputFormat(request.schema),
              // Haiku 4.5 는 effort 를 지원하지 않는다
              ...(spec.supportsEffort ? { effort: 'medium' as const } : {}),
            },
            // 분석 품질보다 결정성이 중요하므로 thinking 은 켜지 않는다.
            ...(spec.supportsEffort ? { thinking: { type: 'disabled' as const } } : {}),
          });
        } catch (err) {
          throw toUpstream(err);
        }
      });

      if (response.stop_reason === 'refusal') {
        throw new SchemaViolationError(
          'Anthropic 안전 필터가 요청을 거부했습니다.',
          response.stop_details?.explanation ?? undefined,
        );
      }
      if (response.parsed_output === null || response.parsed_output === undefined) {
        throw new SchemaViolationError('LLM 응답이 스키마를 만족하지 못했습니다.');
      }

      const usage = {
        inputTokens: response.usage.input_tokens ?? 0,
        outputTokens: response.usage.output_tokens ?? 0,
      };

      return {
        data: response.parsed_output as T,
        usage,
        estimatedCostUsd: estimateCostUsd(spec, usage),
        provider: 'anthropic',
        model: spec.id,
      };
    },

    async embed(): Promise<number[][]> {
      // Anthropic 은 임베딩 API 를 제공하지 않는다.
      // 임베딩은 항상 OpenAI provider 로 위임한다 (lib/llm/index.ts 참고).
      throw new Error('Anthropic provider 는 임베딩을 지원하지 않습니다.');
    },
  };
}

function toUpstream(err: unknown): unknown {
  if (err instanceof Anthropic.APIError) {
    return new UpstreamError(`Anthropic API 오류: ${err.message}`, err.status ?? 500);
  }
  return err;
}
