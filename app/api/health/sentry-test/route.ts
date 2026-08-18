import { NextRequest } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { jsonError } from '@/lib/api/error-response';
import { withRequest } from '@/lib/api/with-request';
import { getRequestId } from '@/lib/request-context';
import { setSentryActionContext } from '@/lib/sentry/context';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  return withRequest(request, () => {
    if (process.env.NODE_ENV !== 'development') {
      return jsonError('Not found', 'NOT_FOUND', 404);
    }
    const requestId = getRequestId() || 'dev-test';
    setSentryActionContext({ action: 'sentry-test', workspaceId: 'default' });
    Sentry.captureException(new Error('Navroop sentry-test'), {
      tags: { requestId, action: 'sentry-test' },
    });
    return Response.json({
      ok: true,
      requestId,
      error: { message: 'Sentry test event sent', code: 'SENTRY_TEST', requestId },
    });
  });
}
