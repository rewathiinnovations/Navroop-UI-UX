import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { getTopRecurringIssues } from '@/lib/audit/actions';
import { getQualityDashboard } from '@/lib/signals/metrics';
import { parseQualityRange } from '@/lib/signals/range';

export async function GET(request: NextRequest) {
  const { user, error, status } = await requireAdmin();
  if (!user) {
    return NextResponse.json({ error }, { status });
  }

  const range = parseQualityRange(request.nextUrl.searchParams);
  if (!range.ok) {
    return NextResponse.json({ error: range.error, details: range.details }, { status: range.status });
  }

  const [dashboard, issues] = await Promise.all([
    getQualityDashboard(range.data.from, range.data.to),
    getTopRecurringIssues(),
  ]);
  return NextResponse.json({
    ...dashboard,
    recurringIssues: issues.ok ? issues.data : [],
  });
}
