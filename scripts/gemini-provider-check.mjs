/**
 * gemini.ts provider 를 SDK 경유로 실제 호출한다.
 * REST 스모크(gemini-smoke.mjs)와 달리 zod 스키마 변환·응답 검증 경로까지 태운다.
 *   npx tsx scripts/gemini-provider-check.mjs
 */
import fs from 'node:fs';
import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';

const env = Object.fromEntries(
  fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
);

const UNSUPPORTED = new Set(['additionalProperties','$schema','minLength','maxLength','minimum','maximum','minItems','maxItems','exclusiveMinimum','exclusiveMaximum']);
const strip = (n) => Array.isArray(n) ? n.map(strip)
  : (n === null || typeof n !== 'object') ? n
  : Object.fromEntries(Object.entries(n).filter(([k]) => !UNSUPPORTED.has(k)).map(([k, v]) => [k, strip(v)]));

const schema = z.object({
  is_investment_relevant: z.boolean(),
  event_type: z.enum(['policy_regulation', 'tariff_trade', 'commodity_price']).nullable(),
  confidence: z.number().int().min(0).max(100),
  reason: z.string().max(200),
});

const client = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
const model = 'gemini-3.1-flash-lite';

const res = await client.models.generateContent({
  model,
  contents: [{ role: 'user', parts: [{ text: '미국이 한국산 변압기에 관세 25%를 부과한다고 발표했다.' }] }],
  config: {
    systemInstruction: '뉴스가 투자 관련인지 판정하라.',
    responseMimeType: 'application/json',
    responseJsonSchema: strip(z.toJSONSchema(schema, { io: 'output', target: 'draft-7' })),
    maxOutputTokens: 1024,
  },
});

console.log('모델      :', model);
console.log('원문      :', res.text?.trim().replace(/\s+/g, ' ').slice(0, 200));
console.log('토큰      : 입력', res.usageMetadata?.promptTokenCount, '/ 출력', res.usageMetadata?.candidatesTokenCount);

const parsed = schema.safeParse(JSON.parse(res.text));
console.log('zod 검증  :', parsed.success ? '✅ 통과' : '❌ 실패');
if (!parsed.success) console.log(parsed.error.issues.slice(0, 3));
else console.log('파싱 결과 :', parsed.data);

const emb = await client.models.embedContent({
  model: 'gemini-embedding-001',
  contents: ['변압기 제조', '반도체 장비'],
  config: { outputDimensionality: 1536 },
});
console.log('임베딩    :', emb.embeddings?.length, '건 ×', emb.embeddings?.[0]?.values?.length, '차원');
