import { NextResponse } from 'next/server';
import { getUsageBreakdown } from '@/lib/plans/actions';

export async function GET() {
  const result = await getUsageBreakdown();
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json(result.data);
}
