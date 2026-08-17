import { NextResponse } from 'next/server';
import { authorizeCron } from '@/lib/cron/auth';
import { purgeDeletedProjects } from '@/lib/projects/purge-deleted';

export async function POST(request: Request) {
  if (!authorizeCron(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const result = await purgeDeletedProjects();
  return NextResponse.json(result);
}
