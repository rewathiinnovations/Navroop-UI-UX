import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { getWorkspaceAdminSettings, updateWorkspaceAdminSettings } from '@/lib/plans/actions';

export async function GET() {
  const { user, error, status } = await requireAdmin();
  if (!user) return NextResponse.json({ error }, { status });
  const result = await getWorkspaceAdminSettings();
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json(result.data);
}

export async function PATCH(request: NextRequest) {
  const { user, error, status } = await requireAdmin();
  if (!user) return NextResponse.json({ error }, { status });
  const body = (await request.json().catch(() => ({}))) as {
    memberMonthlyCreditCap?: number | null;
    generationPaused?: boolean;
    monthlySpendLimitUsd?: number | null;
  };
  const result = await updateWorkspaceAdminSettings(body);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json(result.data);
}
