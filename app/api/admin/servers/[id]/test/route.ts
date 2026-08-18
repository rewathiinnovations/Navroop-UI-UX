import { NextResponse } from 'next/server';
import { testCoolifyServerAction } from '@/lib/coolify/server-actions';
import { actionError } from '@/lib/team/http';

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const result = await testCoolifyServerAction(id);
  if (!result.ok) return actionError(result);
  return NextResponse.json(result.data);
}
