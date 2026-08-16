import { NextRequest, NextResponse } from 'next/server';
import { listTeam, updateMemberRole } from '@/lib/team/actions';
import { actionError } from '@/lib/team/http';
import type { TeamRole } from '@/lib/team/schema';

export async function GET() {
  const result = await listTeam();
  if (!result.ok) return actionError(result);
  return NextResponse.json(result.data);
}

export async function PATCH(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const userId = typeof body.userId === 'string' ? body.userId : '';
  const result = await updateMemberRole(userId, body.role as TeamRole);
  if (!result.ok) return actionError(result);
  return NextResponse.json({ member: result.data });
}
