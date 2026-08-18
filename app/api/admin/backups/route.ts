import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { getBackupAdmin } from '@/lib/backup/admin';

export const dynamic = 'force-dynamic';

export async function GET() {
  const { user } = await requireAdmin();
  if (!user) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const data = await getBackupAdmin();
  return NextResponse.json(data);
}
