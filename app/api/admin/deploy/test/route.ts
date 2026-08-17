import { NextResponse } from 'next/server';
import { testDeployConnection } from '@/lib/coolify/actions';
import { actionError } from '@/lib/team/http';

export async function POST() {
  const result = await testDeployConnection();
  if (!result.ok) return actionError(result);
  return NextResponse.json(result.data);
}
