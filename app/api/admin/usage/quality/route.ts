import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { getTopRecurringIssues } from '@/lib/audit/actions';

export async function GET() {
  const { user, error, status } = await requireAdmin();
  if (!user) {
    return NextResponse.json({ error }, { status });
  }

  const result = await getTopRecurringIssues();
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json({ issues: result.data });
}
