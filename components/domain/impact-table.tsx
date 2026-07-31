import Link from 'next/link';
import { Table, Td, Th } from '@/components/ui/primitives';
import { EvidenceBadge, LevelBadge, RelationBadge, strongestEvidenceKind } from './badges';
import { ScoreCell } from './score';
import { formatDate } from '@/lib/shared/format';
import type { ImpactWithCompany } from '@/lib/queries/events';

/**
 * 영향 종목 표 (PRODUCT_SPEC §6.2 3~6번 섹션 공통).
 *
 * 모바일에서는 가로 스크롤 대신 카드 리스트로 전환한다.
 */
export function ImpactTable({ impacts }: { impacts: ImpactWithCompany[] }) {
  if (impacts.length === 0) {
    return <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-xs text-muted">해당 종목이 없습니다.</p>;
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
              <Th className="text-right">관련도</Th>
              <Th>강도</Th>
              <Th>관계</Th>
              <Th>영향 경로 · 연결 근거</Th>
              <Th>근거 출처</Th>
              <Th>신뢰등급</Th>
            </tr>
          </thead>
          <tbody>
            {impacts.map((impact) => (
              <tr key={impact.id} className="align-top">
                <Td className="font-medium">
                  {impact.company?.stock_code ? (
                    <Link
                      href={`/companies/${impact.company.stock_code}`}
                      className="hover:underline underline-offset-4"
                    >
                      {impact.company.company_name}
                    </Link>
                  ) : (
                    (impact.company?.company_name ?? '—')
                  )}
                </Td>
                <Td className="tnum text-muted">{impact.company?.stock_code ?? '—'}</Td>
                <Td className="text-muted">{impact.company?.market ?? '—'}</Td>
                <Td className="text-right">
                  <ScoreCell score={impact.relevance_score} breakdown={impact.score_breakdown} />
                </Td>
                <Td>
                  <LevelBadge level={impact.impact_level} />
                </Td>
                <Td>
                  <RelationBadge relation={impact.relation_type} />
                </Td>
                <Td className="max-w-md">
                  <p className="text-xs leading-relaxed">{impact.rationale ?? '—'}</p>
                  {impact.transmission_path.length > 0 ? (
                    <p className="mt-1 text-[11px] text-muted">
                      {impact.transmission_path.join(' → ')}
                    </p>
                  ) : null}
                  {impact.missing_evidence.length > 0 ? (
                    <p className="mt-1 text-[11px] text-warn">
                      확인 필요: {impact.missing_evidence.join(', ')}
                    </p>
                  ) : null}
                </Td>
                <Td className="max-w-[14rem]">
                  <EvidenceList impact={impact} />
                </Td>
                <Td>
                  <EvidenceBadge kind={strongestEvidenceKind(impact.evidence.map((e) => e.source_type))} />
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
            <div className="flex items-baseline justify-between gap-2">
              <div>
                <p className="text-sm font-semibold">{impact.company?.company_name ?? '—'}</p>
                <p className="tnum text-xs text-muted">
                  {impact.company?.stock_code ?? '—'} · {impact.company?.market ?? '—'}
                </p>
              </div>
              <ScoreCell score={impact.relevance_score} breakdown={impact.score_breakdown} />
            </div>
            <div className="mt-2 flex flex-wrap gap-1">
              <LevelBadge level={impact.impact_level} />
              <RelationBadge relation={impact.relation_type} />
              <EvidenceBadge kind={strongestEvidenceKind(impact.evidence.map((e) => e.source_type))} />
            </div>
            <p className="mt-2 text-xs leading-relaxed">{impact.rationale ?? '—'}</p>
            <div className="mt-2">
              <EvidenceList impact={impact} />
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}

function EvidenceList({ impact }: { impact: ImpactWithCompany }) {
  if (impact.evidence.length === 0) {
    return <span className="text-[11px] text-muted">연결된 근거 없음</span>;
  }
  return (
    <ul className="space-y-1">
      {impact.evidence.slice(0, 3).map((evidence) => (
        <li key={evidence.id} className="text-[11px] leading-snug">
          {evidence.source_url ? (
            <a
              href={evidence.source_url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent hover:underline underline-offset-2"
            >
              {evidence.source_title}
            </a>
          ) : (
            <span>{evidence.source_title}</span>
          )}
          <span className="text-muted"> · {formatDate(evidence.source_date)}</span>
          {evidence.excerpt ? (
            <p className="mt-0.5 line-clamp-2 text-muted">&ldquo;{evidence.excerpt}&rdquo;</p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
