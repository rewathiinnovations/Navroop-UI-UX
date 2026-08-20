import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { runDbBackup } from '@/lib/backup/db';

export const maxDuration = 300;

export async function POST() {
  const { user } = await requireAdmin();
  if (!user) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const result = await runDbBackup();
  if (!result.ok) {
    // 409, not 500: a backup that is already running has not failed, and the run holding the
    // claim writes the only receipt (F-722).
    const status = 'alreadyRunning' in result ? 409 : 500;
    return NextResponse.json(result, { status });
  }
  return NextResponse.json(result);
}
