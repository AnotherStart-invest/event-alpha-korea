/**
 * Gemini 연결 확인. 키가 유효한지, 어떤 모델이 무료로 열려 있는지 본다.
 *   node scripts/gemini-smoke.mjs
 */
import fs from 'node:fs';

const env = Object.fromEntries(
  fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
);
const key = env.GEMINI_API_KEY;
if (!key) throw new Error('GEMINI_API_KEY 가 없습니다.');
console.log('키 앞부분:', key.slice(0, 8) + '…', `(${key.length}자)`);

const BASE = 'https://generativelanguage.googleapis.com/v1beta';

// 1) 키 유효성 + 사용 가능한 모델
const list = await fetch(`${BASE}/models?key=${key}`);
console.log('\n[모델 목록] HTTP', list.status);
const listBody = await list.text();
if (!list.ok) {
  console.log(listBody.slice(0, 600));
  process.exit(1);
}
const models = JSON.parse(listBody).models ?? [];
const usable = models
  .filter((m) => (m.supportedGenerationMethods ?? []).includes('generateContent'))
  .map((m) => m.name.replace('models/', ''));
console.log('generateContent 가능:', usable.length, '개');
for (const m of usable.filter((n) => /2\.5|3\./.test(n)).slice(0, 12)) console.log('  ·', m);

// 2) 구조화 출력 실호출
const body = {
  contents: [{ role: 'user', parts: [{ text: '삼성전자가 미국에 반도체 공장을 짓는다는 뉴스다.' }] }],
  systemInstruction: { parts: [{ text: '뉴스가 투자 관련인지 판정하라.' }] },
  generationConfig: {
    responseMimeType: 'application/json',
    responseJsonSchema: {
      type: 'object',
      properties: {
        is_investment_relevant: { type: 'boolean' },
        confidence: { type: 'integer' },
        reason: { type: 'string' },
      },
      required: ['is_investment_relevant', 'confidence', 'reason'],
    },
    maxOutputTokens: 512,
  },
};

// MODELS.gemini 와 같은 모델을 쓴다. 바꿀 때 여기도 같이 고칠 것.
for (const model of ['gemini-3.1-flash-lite', 'gemini-3.5-flash']) {
  const r = await fetch(`${BASE}/models/${model}:generateContent?key=${key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const t = await r.text();
  console.log(`\n[${model}] HTTP ${r.status}`);
  if (!r.ok) { console.log('  ', t.slice(0, 300)); continue; }
  const j = JSON.parse(t);
  console.log('   응답:', j.candidates?.[0]?.content?.parts?.[0]?.text?.trim());
  console.log('   토큰: 입력', j.usageMetadata?.promptTokenCount, '/ 출력', j.usageMetadata?.candidatesTokenCount);
}

// 3) 임베딩 (1536 차원이 나와야 DB 와 맞는다)
const er = await fetch(`${BASE}/models/gemini-embedding-001:embedContent?key=${key}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: 'models/gemini-embedding-001',
    content: { parts: [{ text: '변압기 제조' }] },
    outputDimensionality: 1536,
  }),
});
console.log('\n[임베딩] HTTP', er.status);
const et = await er.text();
if (er.ok) console.log('   차원:', JSON.parse(et).embedding?.values?.length);
else console.log('  ', et.slice(0, 300));
