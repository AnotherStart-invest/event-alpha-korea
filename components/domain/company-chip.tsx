import Link from 'next/link';
import { Badge } from '@/components/ui/primitives';
import { EvidenceBadge, strongestEvidenceKind } from './badges';
import { ScoreCell } from './score';
import { LiveQuote } from './live-quote';
import { formatDate, formatMarketCap } from '@/lib/shared/format';
import type { ScoreBreakdown } from '@/lib/db/types';
import type { ImpactWithCompany } from '@/lib/queries/events';

/**
 * 종목 한 장.
 *
 * 이전에는 9열 표(종목명·코드·시장·관련도·강도·관계·영향경로·근거출처·신뢰등급)였다.
 * 정보를 다 펼쳐 놓으니 어느 것이 중요한지 알 수 없었고, 투자자가 실제로 먼저 보는
 * **왜 이 종목인가**가 나머지에 묻혔다. 여기서는 관련도와 한 줄 이유를 앞세우고
 * 근거·출처는 접는다.
 */
export function CompanyChip({ impact }: { impact: ImpactWithCompany }) {
  const company = impact.company;
  if (!company) return null;

  const breakdown = impact.score_breakdown as ScoreBreakdown;
  const focus = breakdown?.focus ?? 0;

  return (
    <li className="rounded-md border border-border bg-background px-3 py-2.5 transition-colors hover:border-border-strong">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            {company.stock_code ? (
              <Link
                href={`/companies/${company.stock_code}`}
                className="text-sm font-semibold hover:underline underline-offset-4"
              >
                {company.company_name}
              </Link>
            ) : (
              <span className="text-sm font-semibold">{company.company_name}</span>
            )}
            <span className="tnum text-[11px] text-muted">
              {company.stock_code ?? '—'}
              {company.market ? ` · ${company.market}` : ''}
            </span>
            {company.market_cap ? (
              <span className="tnum text-[11px] text-muted">
                · {formatMarketCap(company.market_cap)}
              </span>
            ) : null}
          </div>
          {company.industry_name ? (
            <p className="mt-0.5 truncate text-[11px] text-muted">{company.industry_name}</p>
          ) : null}
        </div>

        <div className="flex shrink-0 items-baseline gap-3">
          <LiveQuote code={company.stock_code} className="text-sm" />
          <ScoreCell score={impact.relevance_score} breakdown={impact.score_breakdown} />
        </div>
      </div>

      {/* 집중도는 이 종목이 왜 뽑혔는지를 한마디로 말해 준다.
          0009 이전에 채점된 행에는 없으므로 있을 때만 보여준다. */}
      {focus > 0 ? (
        <p className="mt-1.5">
          <Badge tone={focus >= 15 ? 'positive' : 'outline'}>
            {focus >= 15 ? '주력 사업' : '사업 일부'}
          </Badge>
        </p>
      ) : null}

      <details className="group mt-1.5">
        <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[11px] text-muted-strong">
          <EvidenceBadge kind={strongestEvidenceKind(impact.evidence.map((e) => e.source_type))} />
          <span className="group-open:hidden">왜 이 종목인가</span>
          <span className="hidden group-open:inline">접기</span>
        </summary>
        <div className="mt-2 border-t border-border pt-2">
          <p className="text-xs leading-relaxed">{impact.rationale ?? '연결 근거가 없습니다.'}</p>

          {breakdown?.notes?.length ? (
            <ul className="mt-1.5 space-y-0.5 text-[11px] text-muted">
              {breakdown.notes.map((note, i) => (
                <li key={i}>· {note}</li>
              ))}
            </ul>
          ) : null}

          {impact.evidence.length > 0 ? (
            <ul className="mt-2 space-y-1">
              {impact.evidence.slice(0, 3).map((evidence) => (
                <li key={evidence.id} className="text-[11px] leading-snug">
                  {evidence.source_url ? (
                    <a
                      href={evidence.source_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-accent hover:underline underline-offset-2"
                    >
                      {evidence.source_title} ↗
                    </a>
                  ) : (
                    <span>{evidence.source_title}</span>
                  )}
                  <span className="text-muted"> · {formatDate(evidence.source_date)}</span>
                </li>
              ))}
            </ul>
          ) : null}

          {impact.missing_evidence.length > 0 ? (
            <p className="mt-2 text-[11px] text-warn">
              확인 필요: {impact.missing_evidence.join(', ')}
            </p>
          ) : null}
        </div>
      </details>
    </li>
  );
}
