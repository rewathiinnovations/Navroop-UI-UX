import { NextRequest, NextResponse } from 'next/server';
import { deleteOrgApiKey, listOrgApiKeys, setOrgApiKey } from '@/lib/api-keys/actions';
import { actionError } from '@/lib/team/http';

export async function GET() {
  const result = await listOrgApiKeys();
  if (!result.ok) return actionError(result);
  return NextResponse.json(result.data);
}

export async function PUT(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const provider = typeof body.provider === 'string' ? body.provider : '';
  const secret = typeof body.secret === 'string' ? body.secret : '';
  const result = await setOrgApiKey(provider, secret);
  if (!result.ok) return actionError(result);
  return NextResponse.json(result.data);
}

export async function DELETE(request: NextRequest) {
  const provider = request.nextUrl.searchParams.get('provider') || '';
  const result = await deleteOrgApiKey(provider);
  if (!result.ok) return actionError(result);
  return NextResponse.json(result.data);
}
