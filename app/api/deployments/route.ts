import { NextResponse } from 'next/server';
import { listWorkspaceDeployments } from '@/lib/publish/actions';

export async function GET() {
  const result = await listWorkspaceDeployments();
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json(result.data);
}
