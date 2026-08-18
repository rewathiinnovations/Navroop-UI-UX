import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { connectSentryWithDsn } from '@/lib/integrations/sentry';
import { inspectSentryToken } from '@/lib/integrations/sentry-oauth';
import { persistSentryConnection } from '@/lib/integrations/sentry-persist';
import { sendDsnVerificationEvent } from '@/lib/integrations/sentry-verify';
import { listPublicIntegrations } from '@/lib/integrations/public';
import { parseSentryDsn } from '@/lib/observability/dsn';

export async function POST(request: Request) {
  const { user, error, status } = await requireAdmin();
  if (!user) return NextResponse.json({ error }, { status });
  const body = (await request.json().catch(() => ({}))) as {
    dsn?: string;
    authToken?: string;
    environment?: string;
  };
  const dsn = body.dsn?.trim() || '';
  const parsed = parseSentryDsn(dsn);
  const result = await connectSentryWithDsn({
    dsn,
    authToken: body.authToken,
    environment: body.environment,
    sendVerification: () => sendDsnVerificationEvent(dsn),
    inspectToken: body.authToken?.trim()
      ? () => inspectSentryToken({ authToken: body.authToken!.trim(), projectId: parsed?.projectId })
      : undefined,
    persist: async (input) => {
      await persistSentryConnection({
        ...input,
        connectedById: user.id,
      });
    },
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 422 });
  return NextResponse.json({ ...result, ...(await listPublicIntegrations()) });
}
