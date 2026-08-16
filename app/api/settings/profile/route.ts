import { NextRequest, NextResponse } from 'next/server';
import { updateProfile } from '@/lib/profile/actions';
import { actionError } from '@/lib/team/http';

export async function PATCH(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const result = await updateProfile({
    name: typeof body.name === 'string' ? body.name : undefined,
    avatarUrl:
      body.avatarUrl === null || typeof body.avatarUrl === 'string' ? body.avatarUrl : undefined,
  });
  if (!result.ok) return actionError(result);
  return NextResponse.json({ user: result.data });
}
