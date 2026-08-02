import Link from 'next/link';
import { Table, Td, Th } from '@/components/ui/primitives';
import { LiveQuote } from './live-quote';
import { formatDate } from '@/lib/shared/format';
import { VISIBLE_PER_GROUP, compareForDisplay, type ImpactWithCompany } from '@/lib/queries/events';

/**
 * 근거가 한 줄뿐인 종목을 보여주는 표.
 *
 * ImpactTable 과 달리 관련도 점수·영향 강도·관계 유형을 쓰지 않는다.
 * 그 값들은 LLM 분석이 있어야 의미가 생기는데, 여기서는 근거가
 * "기사에 이름이 나왔다"(mention) 또는 "같은 제품을 판다"(peer)
 * 하나뿐이라 칸을 채우면 오히려 과장이 된다.
 *
 * 두 근거를 한 표에 섞지 않는다. 성격이 달라서 같은 칸에 넣으면
 * 어느 쪽이 어느 근거인지 읽는 사람이 구분할 수 없다.
 *
 * 현재가만은 예외로 싣는다. 근거가 약할수록 지금 얼마인지가 더 궁금해진다.
 */
export function MentionTable({
  impacts,
  kind = 'mention',
}: {
  impacts: ImpactWithCompany[];
  kind?: 'mention' | 'peer' | 'keyword';
}) {
  if (impacts.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-xs text-muted">
        {kind === 'mention'
          ? '기사에서 상장사 이름을 찾지 못했습니다.'
          : '해당 종목이 없습니다.'}
      </p>
    );
  }

  // 상한을 건다. 20개를 늘어놓는 것보다 틀리지 않는 5개가 낫다.
  const ranked = [...impacts].sort(compareForDisplay);
  const shown = ranked.slice(0, VISIBLE_PER_GROUP);
  const hidden = ranked.length - shown.length;

  // 열 제목이 근거의 성격을 정확히 말해야 한다. 문자열 매칭 결과에 "언급된 대목" 이라고
  // 붙이면, 인용된 것이 기사 문장이라는 뜻이 되어 사실이 아니게 된다.
  const reasonHeader =
    kind === 'peer' ? '겹치는 제품' : kind === 'keyword' ? '겹친 사업 설명' : '언급된 대목';

  return (
    <>
      {/* 데스크톱 */}
      <div className="hidden md:block">
        <Table>
          <thead>
            <tr>
              <Th>종목명</Th>
              <Th>코드</Th>
              <Th>시장</Th>
              <Th>업종</Th>
              <Th>현재가</Th>
              <Th>{reasonHeader}</Th>
            </tr>
          </thead>
          <tbody>
            {shown.map((impact) => (
              <tr key={impact.id} className="align-top">
                <Td className="font-medium">
                  <CompanyLink impact={impact} />
                </Td>
                <Td className="tnum text-muted">{impact.company?.stock_code ?? '—'}</Td>
                <Td className="text-muted">{impact.company?.market ?? '—'}</Td>
                <Td className="max-w-[12rem] text-xs text-muted">
                  {impact.company?.industry_name ?? '—'}
                </Td>
                <Td>
                  <LiveQuote code={impact.company?.stock_code ?? null} className="text-xs" />
                </Td>
                <Td className="max-w-lg">
                  <Reason impact={impact} kind={kind} />
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </div>

      {/* 모바일 */}
      <ul className="space-y-2 md:hidden">
        {shown.map((impact) => (
          <li key={impact.id} className="rounded-lg border border-border bg-surface p-3">
            <p className="text-sm font-semibold">
              <CompanyLink impact={impact} />
            </p>
            <p className="tnum text-xs text-muted">
              {impact.company?.stock_code ?? '—'} · {impact.company?.market ?? '—'}
            </p>
            {impact.company?.industry_name ? (
              <p className="mt-0.5 text-xs text-muted">{impact.company.industry_name}</p>
            ) : null}
            <div className="mt-1.5">
              <LiveQuote code={impact.company?.stock_code ?? null} className="text-xs" />
            </div>
            <div className="mt-2">
              <Reason impact={impact} kind={kind} />
            </div>
          </li>
        ))}
      </ul>

      {hidden > 0 ? (
        <p className="mt-1.5 text-[11px] text-muted">표시하지 않은 종목 {hidden}개</p>
      ) : null}
    </>
  );
}

function CompanyLink({ impact }: { impact: ImpactWithCompany }) {
  if (!impact.company?.stock_code) return <>{impact.company?.company_name ?? '—'}</>;
  return (
    <Link href={`/companies/${impact.company.stock_code}`} className="hover:underline underline-offset-4">
      {impact.company.company_name}
    </Link>
  );
}

function Reason({
  impact,
  kind,
}: {
  impact: ImpactWithCompany;
  kind: 'mention' | 'peer' | 'keyword';
}) {
  // 동종 확장은 기사 근거가 없다. 근거는 "무슨 제품이 겹치는가"이고
  // 그건 score_breakdown 의 notes 에 그대로 적혀 있다.
  if (kind === 'peer') {
    const note = impact.score_breakdown?.notes?.[0];
    return (
      <p className="text-xs leading-relaxed text-muted-strong">{note ?? '같은 제품군'}</p>
    );
  }

  const evidence = impact.evidence[0];
  if (!evidence) return <span className="text-[11px] text-muted">근거 없음</span>;

  // ⚠️ 키워드 매칭의 인용문은 **기사 문장이 아니라 회사의 KRX 주요제품 설명**이다.
  // 그냥 큰따옴표로 묶어 놓으면 기사에서 따온 것처럼 읽힌다.
  if (kind === 'keyword') {
    return (
      <div className="text-xs leading-relaxed">
        {evidence.excerpt ? (
          <p className="text-muted-strong">&ldquo;{evidence.excerpt}&rdquo;</p>
        ) : null}
        <p className="mt-1 text-[11px] text-warn">
          출처: {evidence.source_title} — 기사 문장이 아니라 회사 사업 설명입니다
        </p>
      </div>
    );
  }

  return (
    <div className="text-xs leading-relaxed">
      {evidence.excerpt ? <p className="text-muted-strong">&ldquo;{evidence.excerpt}&rdquo;</p> : null}
      <p className="mt-1 text-[11px] text-muted">
        {evidence.source_url ? (
          <a
            href={evidence.source_url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent hover:underline underline-offset-2"
          >
            원문 ↗
          </a>
        ) : null}
        <span className="ml-1">{formatDate(evidence.source_date)}</span>
      </p>
    </div>
  );
}
