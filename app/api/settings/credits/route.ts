import { NextResponse } from 'next/server';
import { getCreditMeter } from '@/lib/plans/actions';

export async function GET() {
  const result = await getCreditMeter();
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json(result.data);
}
