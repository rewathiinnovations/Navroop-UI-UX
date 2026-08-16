import { NextRequest, NextResponse } from 'next/server';
import { changePassword } from '@/lib/profile/actions';
import { actionError } from '@/lib/team/http';

export async function PATCH(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : '';
  const newPassword =
    typeof body.newPassword === 'string'
      ? body.newPassword
      : typeof body.nextPassword === 'string'
        ? body.nextPassword
        : '';
  const result = await changePassword(currentPassword, newPassword);
  if (!result.ok) return actionError(result);
  return NextResponse.json(result.data);
}
