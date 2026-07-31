import type { Metadata } from 'next';
import { Card, CardContent, SectionTitle } from '@/components/ui/primitives';
import { EvidenceBadge } from '@/components/domain/badges';

export const metadata: Metadata = { title: '서비스 소개' };

export default function AboutPage() {
  return (
    <div className="max-w-3xl space-y-8">
      <header>
        <h1 className="text-xl font-bold tracking-tight">Event Alpha Korea</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-strong">
          국내 뉴스에서 투자 관련 이벤트를 자동으로 추출하고, 그 이벤트의 경제적 전파 경로를 따라
          국내 상장사 전체에서 <strong>근거가 있는 관련 종목</strong>을 찾아 제시하는 리서치 지원
          도구입니다.
        </p>
      </header>

      <section>
        <SectionTitle>분석 방법</SectionTitle>
        <ol className="space-y-2 text-sm leading-relaxed">
          {[
            '네이버 뉴스 검색 API로 감시 키워드에 걸린 기사를 수집합니다. 기사 본문은 저장하지 않습니다.',
            '제목을 정규화해 같은 사건을 다룬 기사를 하나의 이벤트로 묶습니다. 서로 다른 사건이 섞이지 않도록 보수적으로 병합합니다.',
            'LLM이 사건을 구조화합니다. 이 단계에서 AI는 기업명을 출력할 수 없습니다.',
            '추출된 산업·제품·원재료·지역 키워드로 기업 데이터베이스를 검색해 후보를 만듭니다. 이 검색에는 AI가 개입하지 않습니다.',
            'LLM은 검색된 후보 안에서만 영향 방향을 판정합니다. 후보 밖의 기업이 출력되면 코드가 걸러냅니다.',
            '관련도 점수는 AI가 아니라 코드가 계산합니다. 근거의 종류와 강도만으로 결정됩니다.',
            '관리자가 검수하고 승인한 이벤트만 공개됩니다.',
          ].map((step, index) => (
            <li key={index} className="flex gap-2.5">
              <span className="tnum shrink-0 text-xs font-semibold text-muted">
                {String(index + 1).padStart(2, '0')}
              </span>
              <span>{step}</span>
            </li>
          ))}
        </ol>
      </section>

      <section>
        <SectionTitle>관련도 점수 (100점)</SectionTitle>
        <div className="scroll-x">
          <table className="w-full min-w-[28rem] text-sm">
            <tbody>
              {[
                ['직접 제품 관련성', '25점', '이벤트의 제품·원재료가 기업 사업보고서에 나타나는가'],
                ['실제 매출·수주 근거', '20점', '해당 사업의 매출 비중이 숫자로 확인되는가'],
                ['지역 노출', '15점', '이벤트가 발생한 지역에 매출·생산이 있는가'],
                ['고객·공급망', '15점', '고객사·공급사·경쟁사 관계가 확인되는가'],
                ['공식 공시 근거', '15점', '전자공시 원문에서 확인된 근거인가'],
                ['최근성', '5점', '사업보고서가 얼마나 최신인가'],
                ['단순 테마', '5점', '위 항목이 전부 0일 때만 부여'],
              ].map(([label, max, hint]) => (
                <tr key={label} className="border-b border-border last:border-0">
                  <td className="py-2 pr-3 font-medium">{label}</td>
                  <td className="tnum py-2 pr-4 text-right text-muted">{max}</td>
                  <td className="py-2 text-xs text-muted">{hint}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs text-muted">
          공시 근거와 매출 근거가 모두 없는 종목은 &ldquo;단순 테마&rdquo;로 강등되고 39점을 넘지
          못합니다. 20점 미만은 화면에 표시하지 않습니다.
        </p>
      </section>

      <section>
        <SectionTitle>근거 배지</SectionTitle>
        <ul className="space-y-2 text-sm">
          <li className="flex items-center gap-2">
            <EvidenceBadge kind="dart" />
            <span className="text-muted-strong">전자공시(DART) 원문에서 확인된 근거</span>
          </li>
          <li className="flex items-center gap-2">
            <EvidenceBadge kind="news" />
            <span className="text-muted-strong">뉴스 기사에서 확인된 근거</span>
          </li>
          <li className="flex items-center gap-2">
            <EvidenceBadge kind="ai" />
            <span className="text-muted-strong">AI가 생성한 분석 (오류 포함 가능)</span>
          </li>
          <li className="flex items-center gap-2">
            <EvidenceBadge kind="none" />
            <span className="text-muted-strong">근거 자료가 연결되지 않음</span>
          </li>
        </ul>
      </section>

      <section>
        <SectionTitle>이 서비스가 하지 못하는 것</SectionTitle>
        <Card>
          <CardContent className="pt-4">
            <ul className="space-y-1.5 text-sm leading-relaxed text-muted-strong">
              <li>· 기업 데이터베이스에 없는 관계는 찾지 못합니다. 커버리지가 곧 한계입니다.</li>
              <li>· 사업보고서는 1년에 한 번 갱신되므로 최근 사업 변화 반영이 늦습니다.</li>
              <li>· 비상장 공급업체는 다루지 않습니다.</li>
              <li>· 시세를 사용하지 않으므로 &ldquo;이미 주가에 반영되었는지&rdquo;는 판단하지 못합니다.</li>
              <li>· 오보나 추측성 보도를 완전히 걸러내지 못합니다.</li>
            </ul>
          </CardContent>
        </Card>
      </section>

      <section>
        <SectionTitle>데이터 출처와 저작권</SectionTitle>
        <p className="text-sm leading-relaxed text-muted-strong">
          뉴스는 네이버 뉴스 검색 API를 통해 제목·요약·링크·언론사·발행시각만 저장하며, 기사 본문은
          수집·저장·재배포하지 않습니다. 기업 정보는 금융감독원 전자공시시스템(DART)의 공개 자료를
          사용하며 출처와 공시일을 함께 표시합니다.
        </p>
      </section>

      <section>
        <SectionTitle>고지사항</SectionTitle>
        <Card>
          <CardContent className="pt-4">
            <p className="text-sm leading-relaxed">
              본 서비스는 공개된 뉴스와 전자공시 정보를 자동으로 분석해 제공하는 리서치 지원
              도구입니다. 투자자문·투자권유가 아니며, 특정 종목의 매수·매도를 추천하지 않습니다.
              목표주가나 매매 시점을 제공하지 않습니다. 자동 분석 결과에는 오류가 포함될 수 있으므로
              반드시 원문과 공시를 직접 확인하십시오. 투자 판단과 그 결과에 대한 책임은 이용자
              본인에게 있습니다.
            </p>
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
