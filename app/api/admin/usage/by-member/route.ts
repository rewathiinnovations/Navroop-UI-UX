import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { getUsageByMember, parseUsageRange } from '@/lib/usage-costs';

export async function GET(request: NextRequest) {
  const { user, error, status } = await requireAdmin();
  if (!user) {
    return NextResponse.json({ error }, { status });
  }

  const range = parseUsageRange(request.nextUrl.searchParams);
  if (!range.ok) {
    return NextResponse.json({ error: range.error, details: range.details }, { status: range.status });
  }

  const members = await getUsageByMember(range.data.from, range.data.to);
  return NextResponse.json({ members });
}
