import { NextRequest, NextResponse } from 'next/server';
import { actionError } from '@/lib/projects/http';
import {
  checkProjectDomain,
  emailProjectDomain,
  makeProjectDomainPrimary,
  removeProjectDomain,
} from '@/lib/domains/actions';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; domainId: string }> },
) {
  const { id, domainId } = await params;
  const body = (await request.json().catch(() => ({}))) as { action?: string; email?: string };
  if (body.action === 'primary') {
    const result = await makeProjectDomainPrimary(id, domainId);
    if (!result.ok) return actionError(result);
    return NextResponse.json(result.data);
  }
  if (body.action === 'email') {
    const result = await emailProjectDomain(id, domainId, String(body.email ?? ''));
    if (!result.ok) return actionError(result);
    return NextResponse.json(result.data);
  }
  const result = await checkProjectDomain(id, domainId);
  if (!result.ok) return actionError(result);
  return NextResponse.json(result.data);
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; domainId: string }> },
) {
  const { id, domainId } = await params;
  const body = (await request.json().catch(() => ({}))) as { confirmHostname?: string };
  const result = await removeProjectDomain(id, domainId, body.confirmHostname);
  if (!result.ok) return actionError(result);
  return NextResponse.json(result.data);
}
