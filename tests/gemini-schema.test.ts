import { describe, expect, it } from 'vitest';
import { toGeminiSchema } from '@/lib/llm/gemini';
import {
  companyProfileSchema,
  eventStructureSchema,
  impactBatchSchema,
  prefilterSchema,
} from '@/lib/llm/schemas';

/**
 * Gemini 는 responseJsonSchema 로 OpenAPI 부분집합만 받는다.
 * $ref / $defs 가 남아 있거나 지원 밖 키워드가 섞이면 400 이 떨어지는데,
 * 그러면 파이프라인의 모든 LLM 호출이 통째로 죽는다. 여기서 미리 막는다.
 */

const SCHEMAS = {
  prefilter: prefilterSchema,
  eventStructure: eventStructureSchema,
  impactBatch: impactBatchSchema,
  companyProfile: companyProfileSchema,
} as const;

const FORBIDDEN = [
  '$ref',
  '$defs',
  '$schema',
  'additionalProperties',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'minimum',
  'maximum',
];

describe('toGeminiSchema', () => {
  for (const [name, schema] of Object.entries(SCHEMAS)) {
    describe(name, () => {
      const json = JSON.stringify(toGeminiSchema(schema));

      it('지원하지 않는 키워드가 남지 않는다', () => {
        for (const key of FORBIDDEN) {
          expect(json, `${name} 에 ${key} 가 남아 있다`).not.toContain(`"${key}"`);
        }
      });

      it('객체 구조와 속성이 보존된다', () => {
        const out = toGeminiSchema(schema) as { type?: string; properties?: object };
        expect(out.type).toBe('object');
        expect(Object.keys(out.properties ?? {}).length).toBeGreaterThan(0);
      });
    });
  }

  it('enum 값을 보존한다 — 보존되지 않으면 모델이 임의 문자열을 뱉는다', () => {
    const json = JSON.stringify(toGeminiSchema(prefilterSchema));
    expect(json).toContain('"enum"');
  });

  it('중첩 배열 안의 객체까지 펼친다', () => {
    const out = toGeminiSchema(companyProfileSchema) as {
      properties: { exposures: { type: string; items: { type: string; properties: object } } };
    };
    const items = out.properties.exposures.items;
    expect(out.properties.exposures.type).toBe('array');
    expect(items.type).toBe('object');
    expect(Object.keys(items.properties)).toContain('exposure_value');
  });
});
