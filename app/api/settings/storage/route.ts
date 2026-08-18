import { NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { getEffectivePlan } from '@/lib/plans/limits';
import { getWorkspaceStorage } from '@/lib/storage/usage';

export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Sign in required' }, { status: 401 });
  const [workspace, plan] = await Promise.all([getWorkspaceStorage(), getEffectivePlan()]);
  return NextResponse.json({
    storageBytes: workspace.storageBytes,
    storageLimitBytes: workspace.storageLimitBytes ?? Number(plan.storageBytesLimit),
  });
}
