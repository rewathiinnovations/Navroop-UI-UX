import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { runDbBackup } from '@/lib/backup/db';

export const maxDuration = 300;

export async function POST() {
  const { user } = await requireAdmin();
  if (!user) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const result = await runDbBackup();
  if (!result.ok) {
    return NextResponse.json(result, { status: 500 });
  }
  return NextResponse.json(result);
}
