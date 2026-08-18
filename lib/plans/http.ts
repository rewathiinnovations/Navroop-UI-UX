import { NextResponse } from 'next/server';
import type { ActionErr } from '@/lib/projects/actions';
import type { CreditCheckDenied, LimitCheckResult } from './types';

export type CreditDenialBody = {
  reason: string;
  used: number;
  limit: number;
  message: string;
};

export function isCreditDenial(value: unknown): value is CreditDenialBody {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.reason === 'string' &&
    typeof row.used === 'number' &&
    typeof row.limit === 'number' &&
    typeof row.message === 'string'
  );
}

export function creditDeniedJson(denial: CreditCheckDenied | (LimitCheckResult & { message: string; reason: string })) {
  return NextResponse.json(
    {
      reason: denial.reason,
      used: 'used' in denial ? denial.used : denial.current,
      limit: denial.limit,
      message: denial.message,
    } satisfies CreditDenialBody,
    { status: 402 },
  );
}

export function asCreditActionErr(
  denial: CreditCheckDenied | (LimitCheckResult & { message?: string; reason?: string }),
): ActionErr {
  const message = denial.message || 'Limit reached';
  const reason = 'reason' in denial && denial.reason ? denial.reason : 'limit';
  const used = 'used' in denial ? denial.used : denial.current;
  return {
    ok: false,
    error: message,
    status: 402,
    details: { reason, used, limit: denial.limit, message },
  };
}
