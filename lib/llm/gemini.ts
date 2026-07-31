import 'server-only';
import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';
import { required } from '@/lib/shared/env';
import { QuotaExceededError, SchemaViolationError, UpstreamError, withRetry } from '@/lib/shared/errors';
import { EMBEDDING_MODELS, MODELS, estimateCostUsd } from './models';
import type { LlmProvider, LlmResult, StructuredRequest } from './provider';

/**
 * Google Gemini 구현 (AI Studio).
 *
 * 무료 티어를 카드 등록 없이 쓸 수 있어서 "돈 안 쓰고 돌리는" 경로를 담당한다.
 * 대신 제약이 금액이 아니라 **요청 수**(모델별 하루 250~1,000회)이므로,
 * 한도를 넘기면 과금이 아니라 429 가 떨어진다.
 *
 * structured output 은 responseJsonSchema 로 지시하되, **최종 검증은 zod 가 한다.**
 * Gemini 의 스키마 준수는 OpenAI 만큼 엄격하지 않아서(길이 제약 등은 무시된다)
 * 모델이 지킨다고 믿지 않고 파싱 후 다시 강제하는 편이 안전하다.
 */
export function createGeminiProvider(): LlmProvider {
  const client = new GoogleGenAI({ apiKey: required('GEMINI_API_KEY') });

  return {
    name: 'gemini',

    async structured<T>(request: StructuredRequest<T>): Promise<LlmResult<T>> {
      const spec = MODELS.gemini[request.tier];

      const response = await withRetry(async () => {
        try {
          return await client.models.generateContent({
            model: spec.id,
            contents: [{ role: 'user', parts: [{ text: request.user }] }],
            config: {
              systemInstruction: request.system,
              responseMimeType: 'application/json',
              responseJsonSchema: toGeminiSchema(request.schema),
              maxOutputTokens: request.maxOutputTokens ?? 4096,
              // Gemini 3.x 는 기본으로 사고를 켠다. 사고 토큰이 maxOutputTokens 를
              // 같이 소모해서 본문 JSON 이 중간에 잘리고, 잘린 조각은 파싱에 실패한다.
              // 실측에서 사고 1,214 : 본문 218 로 5배 넘게 먹었다.
              // 사고 토큰은 출력 단가로 과금되기까지 한다. Anthropic provider 가
              // thinking 을 끄는 것과 같은 이유로 여기서도 끈다.
              thinkingConfig: { thinkingBudget: 0 },
            },
          });
        } catch (err) {
          throw toUpstream(err);
        }
      });

      const finishReason = response.candidates?.[0]?.finishReason ?? 'unknown';
      const text = response.text;
      if (!text) {
        // 응답이 비는 대표 원인은 안전필터 차단과 maxOutputTokens 초과다.
        throw new SchemaViolationError(`Gemini 응답이 비었습니다 (finishReason=${finishReason}).`);
      }
      // 잘린 응답은 "JSON 이 아님" 으로 보이지만 원인은 스키마가 아니라 한도다.
      // 구분해두지 않으면 프롬프트를 붙잡고 헤매게 된다.
      if (finishReason === 'MAX_TOKENS') {
        throw new SchemaViolationError(
          `Gemini 응답이 maxOutputTokens 에서 잘렸습니다. 한도를 올리거나 스키마를 줄이십시오.`,
        );
      }

      const meta = response.usageMetadata;
      const usage = {
        inputTokens: meta?.promptTokenCount ?? 0,
        // 사고 토큰도 출력 단가로 과금된다. 빠뜨리면 비용이 과소집계되어
        // 일일 예산 상한이 실제보다 늦게 걸린다.
        outputTokens: (meta?.candidatesTokenCount ?? 0) + (meta?.thoughtsTokenCount ?? 0),
      };

      return {
        data: parseStrict(request.schema, text),
        usage,
        estimatedCostUsd: estimateCostUsd(spec, usage),
        provider: 'gemini',
        model: spec.id,
      };
    },

    async embed(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) return [];
      const spec = EMBEDDING_MODELS.gemini;

      const response = await withRetry(async () => {
        try {
          return await client.models.embedContent({
            model: spec.id,
            contents: texts,
            config: { outputDimensionality: spec.dimensions },
          });
        } catch (err) {
          throw toUpstream(err);
        }
      });

      const vectors = response.embeddings?.map((e) => e.values ?? []) ?? [];
      if (vectors.length !== texts.length) {
        throw new UpstreamError(
          `Gemini 임베딩 개수 불일치: 요청 ${texts.length}건, 응답 ${vectors.length}건`,
          502,
        );
      }
      // 차원이 어긋나면 DB insert 가 아니라 여기서 죽어야 원인을 찾기 쉽다.
      for (const v of vectors) {
        if (v.length !== spec.dimensions) {
          throw new UpstreamError(
            `Gemini 임베딩 차원 불일치: ${v.length} (기대 ${spec.dimensions})`,
            502,
          );
        }
      }
      return vectors;
    },
  };
}

/**
 * zod → JSON Schema.
 *
 * Gemini 는 $ref / $defs 를 처리하지 못하므로 인라인으로 펼친다.
 * additionalProperties 도 받지 않아서 제거한다.
 */
export function toGeminiSchema(schema: z.ZodType<unknown>): unknown {
  return stripUnsupported(z.toJSONSchema(schema, { io: 'output', target: 'draft-7' }));
}

const UNSUPPORTED_KEYS = new Set([
  'additionalProperties',
  '$schema',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'minItems',
  'maxItems',
  'exclusiveMinimum',
  'exclusiveMaximum',
]);

function stripUnsupported(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripUnsupported);
  if (node === null || typeof node !== 'object') return node;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (UNSUPPORTED_KEYS.has(key)) continue;
    out[key] = stripUnsupported(value);
  }
  return out;
}

/** JSON 파싱 + zod 강제. 둘 중 어디서 깨졌는지 구분되게 메시지를 남긴다. */
function parseStrict<T>(schema: z.ZodType<T>, text: string): T {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new SchemaViolationError(`Gemini 응답이 JSON 이 아닙니다: ${text.slice(0, 200)}`);
  }

  const result = schema.safeParse(json);
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new SchemaViolationError(`Gemini 응답이 스키마를 위반했습니다 — ${issues}`);
  }
  return result.data;
}

function toUpstream(err: unknown): unknown {
  if (err && typeof err === 'object' && 'status' in err) {
    const status = Number((err as { status: unknown }).status) || 500;
    const message = err instanceof Error ? err.message : String(err);

    // 하루 한도와 분당 한도는 같은 429 로 오지만 대처가 정반대다.
    // 분당은 기다리면 풀리고, 하루는 자정까지 안 풀린다.
    if (status === 429) {
      const perDay = findPerDayQuota(message);
      if (perDay) return new QuotaExceededError(perDay, message.slice(0, 300));
    }
    return new UpstreamError(`Gemini API 오류: ${message}`, status);
  }
  return err;
}

/**
 * 429 본문에서 **하루** 한도 위반을 찾는다.
 *
 * 실측된 quotaId 예: `GenerateRequestsPerDayPerProjectPerModel-FreeTier`.
 * 분당 한도는 같은 자리에 `PerMinute` 가 들어오므로 그것과 구분된다.
 * 문자열 검사인 이유는 SDK 가 에러 본문을 구조화해서 주지 않기 때문이다.
 */
function findPerDayQuota(message: string): string | null {
  const match = message.match(/"?quotaId"?\s*:?\s*"?([A-Za-z0-9-]*PerDay[A-Za-z0-9-]*)"?/);
  if (match) return match[1];
  return /PerDay/.test(message) ? 'PerDay' : null;
}
