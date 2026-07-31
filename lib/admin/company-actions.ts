'use server';

import { revalidatePath } from 'next/cache';
import { requireAdmin } from '@/lib/db/server';
import { createServiceClient } from '@/lib/db/service';
import { errorMessage } from '@/lib/shared/errors';

export type ActionResult = { ok: true } | { ok: false; error: string };

/**
 * 노출 정보 검수 표시.
 * verified=true 가 되면 점수 계산의 공시 근거 항목이 10점 → 15점이 된다.
 */
export async function setExposureVerified(
  exposureId: string,
  verified: boolean,
): Promise<ActionResult> {
  try {
    const admin = await requireAdmin();
    const supabase = createServiceClient();

    const { data: before } = await supabase
      .from('company_exposures')
      .select('company_id, exposure_value, verified')
      .eq('id', exposureId)
      .maybeSingle();
    if (!before) return { ok: false, error: '노출 정보를 찾을 수 없습니다.' };

    const { error } = await supabase
      .from('company_exposures')
      .update({ verified })
      .eq('id', exposureId);
    if (error) return { ok: false, error: error.message };

    await supabase.from('admin_reviews').insert({
      target_type: 'exposure',
      target_id: exposureId,
      reviewer: admin.id,
      action: verified ? 'verify' : 'unverify',
      diff: { before: before.verified, after: verified },
    });

    // 기업 전체 검수 상태도 갱신
    await supabase
      .from('companies')
      .update({ verification_status: 'reviewed' })
      .eq('id', before.company_id);

    revalidatePath(`/admin/companies/${before.company_id}`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}
