import { NextResponse } from 'next/server';
import { getSessionUser, toPublicUser } from '@/lib/auth';
import { ensureAdminUser } from '@/lib/ensure-admin';

export async function GET() {
  try {
    await ensureAdminUser();
  } catch {
    // Seed is best-effort; login still works if the admin already exists.
  }

  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ user: null }, { status: 401 });
  }
  return NextResponse.json({ user: toPublicUser(user) });
}
