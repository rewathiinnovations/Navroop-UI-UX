import { NextRequest, NextResponse } from 'next/server';
import { getDeploySettings, saveDeploySettings } from '@/lib/coolify/actions';
import { actionError } from '@/lib/team/http';

export async function GET() {
  const result = await getDeploySettings();
  if (!result.ok) return actionError(result);
  return NextResponse.json(result.data);
}

export async function PUT(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl : '';
  const token = typeof body.token === 'string' ? body.token : '';
  const result = await saveDeploySettings({ baseUrl, token });
  if (!result.ok) return actionError(result);
  return NextResponse.json(result.data);
}
