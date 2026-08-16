import { NextRequest, NextResponse } from 'next/server';
import { getLatestCodeAudit, runCodeAudit } from '@/lib/audit/actions';
import { actionError } from '@/lib/projects/http';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const result = await getLatestCodeAudit(id);
  if (!result.ok) return actionError(result);
  return NextResponse.json(result.data);
}

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const result = await runCodeAudit(id);
  if (!result.ok) return actionError(result);
  return NextResponse.json(result.data);
}
