import { NextRequest, NextResponse } from 'next/server';
import { withRequest } from '@/lib/api/with-request';
import { jsonError } from '@/lib/api/error-response';
import { adminUploadThumbnail } from '@/lib/templates/actions';
import { templateActionError } from '@/lib/templates/http';

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  return withRequest(request, async () => {
    const { id } = await context.params;
    const form = await request.formData().catch(() => null);
    const file = form?.get('file');
    if (!(file instanceof File)) {
      return jsonError('Upload a PNG or JPEG file', 'VALIDATION', 400);
    }
    const buffer = Buffer.from(await file.arrayBuffer());
    if (buffer.byteLength < 32 || buffer.byteLength > 4_000_000) {
      return jsonError('Thumbnail must be between 32 bytes and 4 MB', 'VALIDATION', 400);
    }
    const result = await adminUploadThumbnail(id, buffer);
    if (!result.ok) return templateActionError(result);
    return NextResponse.json(result.data);
  });
}
