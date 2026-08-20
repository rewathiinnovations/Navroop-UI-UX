import { NextRequest, NextResponse } from 'next/server';
import { withRequest } from '@/lib/api/with-request';
import { jsonError } from '@/lib/api/error-response';
import { adminUploadThumbnail } from '@/lib/templates/actions';
import { templateActionError } from '@/lib/templates/http';
import { MAX_THUMBNAIL_BYTES, MIN_THUMBNAIL_BYTES, sniffImageType } from '@/lib/assets/optimize';

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  return withRequest(request, async () => {
    const { id } = await context.params;
    const form = await request.formData().catch(() => null);
    const file = form?.get('file');
    if (!(file instanceof File)) {
      return jsonError('Upload a PNG or JPEG file', 'VALIDATION', 400);
    }
    // Both bounds are read off the declared part length, before `arrayBuffer()`
    // materialises anything. A route handler is not covered by the Server Action
    // bodySizeLimit, so a ceiling checked after the buffer exists has already paid the
    // memory it was meant to deny (F-173).
    if (file.size < MIN_THUMBNAIL_BYTES || file.size > MAX_THUMBNAIL_BYTES) {
      return jsonError('Thumbnail must be between 32 bytes and 4 MB', 'VALIDATION', 400);
    }
    const buffer = Buffer.from(await file.arrayBuffer());
    // `storeThumbnailBuffer` uploads these bytes verbatim and labels them `image/png`, so
    // the multipart content type deciding would let any file be stored and served as an
    // image from our own origin. The bytes decide.
    if (!sniffImageType(buffer)) {
      return jsonError('Upload a PNG, JPEG, WebP or GIF image', 'VALIDATION', 400);
    }
    const result = await adminUploadThumbnail(id, buffer);
    if (!result.ok) return templateActionError(result);
    return NextResponse.json(result.data);
  });
}
