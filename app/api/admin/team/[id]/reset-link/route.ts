import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { sendPasswordResetForUser } from '@/lib/password-reset/service';

export async function POST(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { user, error, status } = await requireAdmin();
  if (!user) {
    return NextResponse.json({ error }, { status });
  }

  const { id } = await context.params;
  const result = await sendPasswordResetForUser(id);
  if (!result.ok) {
    return NextResponse.json(result, { status: result.error === 'User not found' ? 404 : 400 });
  }
  return NextResponse.json({ ok: true, message: result.message });
}
