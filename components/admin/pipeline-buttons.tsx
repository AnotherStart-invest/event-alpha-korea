'use client';

import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/primitives';
import { runPipeline } from '@/lib/admin/actions';

const JOBS = [
  { job: 'collect' as const, label: '뉴스 수집', hint: '감시 키워드로 네이버 뉴스를 가져옵니다' },
  { job: 'cluster' as const, label: '이벤트 묶기', hint: '미처리 기사를 이벤트 후보로 묶습니다' },
  { job: 'analyze' as const, label: '분석 실행', hint: 'LLM 분석 + 관련 종목 매칭 (비용 발생)' },
];

export function PipelineButtons() {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [running, setRunning] = useState<string | null>(null);

  function run(job: (typeof JOBS)[number]['job']) {
    setRunning(job);
    setMessage(null);
    startTransition(async () => {
      const result = await runPipeline(job);
      setRunning(null);
      setMessage(
        result.ok
          ? { tone: 'ok', text: `${job} 실행을 완료했습니다.` }
          : { tone: 'error', text: result.error },
      );
    });
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {JOBS.map((item) => (
          <Button
            key={item.job}
            variant="outline"
            size="sm"
            title={item.hint}
            disabled={pending}
            onClick={() => run(item.job)}
          >
            {running === item.job ? '실행 중…' : item.label}
          </Button>
        ))}
      </div>
      {message ? (
        <p className={message.tone === 'ok' ? 'text-xs text-positive' : 'text-xs text-negative'}>
          {message.text}
        </p>
      ) : null}
      <p className="text-xs text-muted">
        분석 실행은 LLM 비용이 발생합니다. 일일 상한을 넘으면 자동으로 중단됩니다.
      </p>
    </div>
  );
}
