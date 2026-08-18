import { NextResponse } from 'next/server';
import { createCoolifyServer, listCoolifyServers } from '@/lib/coolify/server-actions';
import { actionError } from '@/lib/team/http';

export async function GET() {
  const result = await listCoolifyServers();
  if (!result.ok) return actionError(result);
  return NextResponse.json(result.data);
}

export async function POST() {
  const result = await createCoolifyServer();
  return actionError(result);
}
