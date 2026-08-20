import { NextRequest, NextResponse } from 'next/server';
import { log } from '@/lib/logger';
import { applyGithubWebhookEffects } from '@/lib/integrations/github-webhook-effects';
import { interpretGithubWebhook, verifyGithubSignature } from '@/lib/integrations/github-webhook';
import { getIntegration } from '@/lib/integrations/store';
import { DEFAULT_WORKSPACE_ID } from '@/lib/publish/constants';

/**
 * The deploy App's webhook endpoint (F-265).
 *
 * Unauthenticated by necessity — GitHub has no session — and allowlisted in
 * `lib/auth/public-routes.ts` for POST only. What stands in for a session is the HMAC over
 * the raw body, keyed with the `webhookSecret` the App handed over at creation. Nothing is
 * read out of the payload, and nothing is written, until that signature verifies.
 */

export const runtime = 'nodejs';
/** The body must be read verbatim to verify the HMAC, so no caching layer may touch it. */
export const dynamic = 'force-dynamic';

/**
 * GitHub's own limit is 25 MB; the four events subscribed to are a few KB. Anything larger
 * is not one of them, and hashing it would be work done on an unverified caller's behalf.
 */
const MAX_BODY_BYTES = 512 * 1024;

export async function POST(request: NextRequest) {
  const event = request.headers.get('x-github-event');
  const delivery = request.headers.get('x-github-delivery');
  const declaredLength = Number(request.headers.get('content-length') ?? '0');
  if (declaredLength > MAX_BODY_BYTES) {
    log.warn('integrations.github_webhook_refused', { reason: 'too-large', event, delivery });
    return NextResponse.json({ error: 'Payload too large' }, { status: 413 });
  }

  const body = await request.text();
  if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
    log.warn('integrations.github_webhook_refused', { reason: 'too-large', event, delivery });
    return NextResponse.json({ error: 'Payload too large' }, { status: 413 });
  }

  const integration = await getIntegration(DEFAULT_WORKSPACE_ID, 'GITHUB_DEPLOY');
  const check = verifyGithubSignature({
    body,
    signature: request.headers.get('x-hub-signature-256'),
    secret: integration?.secrets.webhookSecret,
  });
  if (!check.ok) {
    // `no-secret` is the operator's problem (no App connected on this instance) and the
    // rest are the caller's, but the response says the same thing to both: an unverified
    // delivery is refused, and the reason stays in the log.
    log.warn('integrations.github_webhook_refused', { reason: check.reason, event, delivery });
    return NextResponse.json({ error: 'Signature verification failed' }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    log.warn('integrations.github_webhook_refused', { reason: 'not-json', event, delivery });
    return NextResponse.json({ error: 'Body is not JSON' }, { status: 400 });
  }

  const effects = interpretGithubWebhook({
    event,
    payload,
    appSlug: integration?.config.slug ?? null,
  });
  const outcome = await applyGithubWebhookEffects(effects, DEFAULT_WORKSPACE_ID);
  log.info('integrations.github_webhook', {
    event,
    delivery,
    effects: effects.map((effect) => (effect.kind === 'ignored' ? effect.reason : effect.kind)),
    applied: outcome.applied,
    skipped: outcome.skipped,
  });
  return NextResponse.json({ ok: true, applied: outcome.applied, skipped: outcome.skipped });
}
