import { NextRequest, NextResponse } from 'next/server';
import { setPreviewPasswordAction } from '@/lib/publish/actions';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = (await request.json().catch(() => ({}))) as { password?: unknown };
  const password = typeof body.password === 'string' ? body.password : null;
  const result = await setPreviewPasswordAction(id, password && password.trim() ? password : null);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json(result.data);
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const result = await setPreviewPasswordAction(id, null);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json(result.data);
}
