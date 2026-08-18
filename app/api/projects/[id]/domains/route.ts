import { NextRequest, NextResponse } from 'next/server';
import { actionError } from '@/lib/projects/http';
import { addProjectDomain, listProjectDomains } from '@/lib/domains/actions';
import type { CustomDomainPath } from '@/lib/domains/types';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const result = await listProjectDomains(id);
  if (!result.ok) return actionError(result);
  return NextResponse.json(result.data);
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = (await request.json().catch(() => ({}))) as { hostname?: string; path?: string };
  const path: CustomDomainPath = body.path === 'B' ? 'B' : 'A';
  const result = await addProjectDomain(id, { hostname: String(body.hostname ?? ''), path });
  if (!result.ok) return actionError(result);
  return NextResponse.json(result.data, { status: 201 });
}
