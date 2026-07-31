import Link from 'next/link';
import { Table, Td, Th } from '@/components/ui/primitives';
import { formatDate } from '@/lib/shared/format';
import type { ImpactWithCompany } from '@/lib/queries/events';

/**
 * 기사에 이름이 나온 종목만 보여주는 표.
 *
 * ImpactTable 과 달리 관련도 점수·영향 강도·관계 유형을 쓰지 않는다.
 * 그 값들은 LLM 분석이 있어야 의미가 생기는데, 여기서는 근거가
 * "기사에 이름이 나왔다" 하나뿐이라 칸을 채우면 오히려 과장이 된다.
 */
export function MentionTable({ impacts }: { impacts: ImpactWithCompany[] }) {
  if (impacts.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-xs text-muted">
        기사에서 상장사 이름을 찾지 못했습니다.
      </p>
    );
  }

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
              <Th>언급된 대목</Th>
            </tr>
          </thead>
          <tbody>
            {impacts.map((impact) => (
              <tr key={impact.id} className="align-top">
                <Td className="font-medium">
                  <CompanyLink impact={impact} />
                </Td>
                <Td className="tnum text-muted">{impact.company?.stock_code ?? '—'}</Td>
                <Td className="text-muted">{impact.company?.market ?? '—'}</Td>
                <Td className="max-w-[12rem] text-xs text-muted">
                  {impact.company?.industry_name ?? '—'}
                </Td>
                <Td className="max-w-lg">
                  <Excerpt impact={impact} />
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </div>

      {/* 모바일 */}
      <ul className="space-y-2 md:hidden">
        {impacts.map((impact) => (
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
            <div className="mt-2">
              <Excerpt impact={impact} />
            </div>
          </li>
        ))}
      </ul>
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

function Excerpt({ impact }: { impact: ImpactWithCompany }) {
  const evidence = impact.evidence[0];
  if (!evidence) return <span className="text-[11px] text-muted">근거 없음</span>;

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
