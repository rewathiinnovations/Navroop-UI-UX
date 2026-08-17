import { NextResponse } from 'next/server';
import { authorizeCron } from '@/lib/cron/auth';
import { thinCheckpoints } from '@/lib/checkpoints/thin';

export async function POST(request: Request) {
  if (!authorizeCron(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const result = await thinCheckpoints();
  return NextResponse.json(result);
}
