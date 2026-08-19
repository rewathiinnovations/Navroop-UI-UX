import { NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { getGitHubConnectionStatusForUser } from '@/lib/github/connection';

export async function GET() {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: 'Sign in required' }, { status: 401 });
  }
  // Reads the plain function, not the `'use server'` wrapper that used to live in
  // lib/github/actions.ts: every export of that module is a public action endpoint,
  // and taking a `userId` argument made it answer for any account. The id here comes
  // from the session, which is the only id this route is allowed to answer for.
  const status = await getGitHubConnectionStatusForUser(prisma, user.id);
  return NextResponse.json(status);
}
