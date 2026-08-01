import { describe, expect, it } from 'vitest';
import { resolveCompanyNames } from '@/lib/matching/resolve';
import { buildMentionDict, type MentionCompany } from '@/lib/matching/mentions';

/**
 * **이 파일이 환각 방어선이다.**
 *
 * LLM 이 기업명을 제안할 수 있게 되면서, "없는 종목이 화면에 뜨지 않는다" 는
 * 보장이 전적으로 이 해석기에 달렸다. 여기가 뚫리면 제품 전체가 뚫린다.
 */

function company(name: string, code: string): MentionCompany {
  return {
    companyId: `id-${code}`,
    companyName: name,
    stockCode: code,
    market: 'KOSPI',
    industryName: null,
    latestReportDate: null,
  };
}

const dict = buildMentionDict([
  company('삼성전자', '005930'),
  company('포스코퓨처엠', '003670'),
  company('현대자동차', '005380'),
  company('LG에너지솔루션', '373220'),
  company('성일하이텍', '365340'),
]);

describe('resolveCompanyNames — 실존 검증', () => {
  it('정식명칭을 해석한다', () => {
    const { resolved } = resolveCompanyNames(dict, ['포스코퓨처엠']);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].company.stockCode).toBe('003670');
  });

  it('**존재하지 않는 회사는 버린다** — 환각이 화면에 닿지 못하는 지점', () => {
    const { resolved, unresolved } = resolveCompanyNames(dict, [
      '한국배터리소재',
      '대한리튬공업',
      '가상전자',
    ]);
    expect(resolved).toHaveLength(0);
    expect(unresolved).toHaveLength(3);
  });

  it('실존 종목과 환각이 섞여 와도 실존만 남는다', () => {
    const { resolved, unresolved } = resolveCompanyNames(dict, [
      '삼성전자',
      '삼성배터리테크', // 없는 회사
      '성일하이텍',
    ]);
    expect(resolved.map((r) => r.company.companyName)).toEqual(['삼성전자', '성일하이텍']);
    expect(unresolved).toEqual(['삼성배터리테크']);
  });

  it('약칭 사전을 탄다', () => {
    expect(resolveCompanyNames(dict, ['현대차']).resolved[0].company.stockCode).toBe('005380');
    expect(resolveCompanyNames(dict, ['LG엔솔']).resolved[0].company.stockCode).toBe('373220');
  });

  it('법인 접미어를 뗀다 — LLM 이 "㈜" 를 붙여 쓸 때가 있다', () => {
    for (const name of ['삼성전자㈜', '(주)삼성전자', '삼성전자 주식회사']) {
      expect(resolveCompanyNames(dict, [name]).resolved[0]?.company.stockCode).toBe('005930');
    }
  });

  it('부분 일치로 넓히지 않는다 — 다른 회사가 된다', () => {
    // "한국전력기술" 을 "한국전력" 으로 해석하면 완전히 다른 종목이다.
    const { resolved } = resolveCompanyNames(dict, ['삼성전자서비스', '포스코']);
    expect(resolved).toHaveLength(0);
  });

  it('같은 회사를 두 번 제안해도 하나만 남긴다', () => {
    const { resolved } = resolveCompanyNames(dict, ['삼성전자', '삼성전자㈜', '삼성전자']);
    expect(resolved).toHaveLength(1);
  });

  it('빈 이름·공백은 조용히 무시한다', () => {
    const { resolved, unresolved } = resolveCompanyNames(dict, ['', '   ', '삼성전자']);
    expect(resolved).toHaveLength(1);
    expect(unresolved).toHaveLength(0);
  });

  it('원래 표기를 남긴다 — 무엇이 어떻게 해석됐는지 봐야 프롬프트를 고칠 수 있다', () => {
    const { resolved } = resolveCompanyNames(dict, ['현대차']);
    expect(resolved[0].proposedName).toBe('현대차');
    expect(resolved[0].company.companyName).toBe('현대자동차');
  });
});
