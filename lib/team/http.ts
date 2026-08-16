import { NextResponse } from 'next/server';
import type { ActionErr } from '@/lib/team/actions';

export function actionError(result: ActionErr) {
  return NextResponse.json(
    { error: result.error, ...(result.details ? { details: result.details } : {}) },
    { status: result.status },
  );
}
