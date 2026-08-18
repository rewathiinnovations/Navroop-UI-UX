import { NextRequest, NextResponse } from 'next/server';
import { withRequest } from '@/lib/api/with-request';
import { adminGenerateThumbnails } from '@/lib/templates/actions';
import { templateActionError } from '@/lib/templates/http';

export async function POST(request: NextRequest) {
  return withRequest(request, async () => {
    const result = await adminGenerateThumbnails();
    if (!result.ok) return templateActionError(result);
    return NextResponse.json(result.data);
  });
}
