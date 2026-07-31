'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/primitives';
import { setExposureVerified } from '@/lib/admin/company-actions';

export function ExposureEditor({
  exposureId,
  verified,
}: {
  exposureId: string;
  verified: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function toggle() {
    startTransition(async () => {
      const result = await setExposureVerified(exposureId, !verified);
      setError(result.ok ? null : result.error);
      if (result.ok) router.refresh();
    });
  }

  return (
    <div className="space-y-1">
      <Button
        size="sm"
        variant={verified ? 'positive' : 'outline'}
        disabled={pending}
        onClick={toggle}
      >
        {verified ? '검수 완료' : '미검수'}
      </Button>
      {error ? <p className="text-[11px] text-negative">{error}</p> : null}
    </div>
  );
}
