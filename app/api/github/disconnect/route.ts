import { NextResponse } from 'next/server';
import { disconnectGitHub } from '@/lib/github/actions';

export async function POST() {
  const result = await disconnectGitHub();
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json(result.data);
}
