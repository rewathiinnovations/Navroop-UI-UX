import { NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { getGitHubConnectionStatus } from '@/lib/github/actions';

export async function GET() {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: 'Sign in required' }, { status: 401 });
  }
  const status = await getGitHubConnectionStatus(user.id);
  return NextResponse.json(status);
}
