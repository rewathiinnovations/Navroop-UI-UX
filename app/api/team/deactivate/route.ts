import { NextRequest, NextResponse } from 'next/server';
import { deactivateMember } from '@/lib/team/actions';
import { actionError } from '@/lib/team/http';

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const userId = typeof body.userId === 'string' ? body.userId : '';
  const result = await deactivateMember(userId);
  if (!result.ok) return actionError(result);
  return NextResponse.json({ member: result.data });
}
