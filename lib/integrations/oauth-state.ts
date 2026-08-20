import { prisma } from '@/lib/db';
import { log } from '@/lib/logger';
import { consumeRow } from './single-use';

/**
 * Single-use OAuth/CSRF state, one row per flow.
 *
 * Both connect flows used to `upsert` a *single* `AppSetting` row per provider
 * (`integration.github.csrf`, `integration.sentry.oauth`), so starting a flow silently
 * invalidated any other in flight. Two admins connecting at once — or one admin who opened
 * the flow twice after a slow redirect, which is the common reflex — meant the first
 * callback failed state validation and redirected to a generic `?reason=state` with nothing
 * explaining why (F-242).
 *
 * The row is now keyed by the state value, so concurrent flows are independent, and a
 * failure says which of the three things happened. `consumeRow` still does the atomic
 * single-use delete: a nonce we cannot prove we consumed is one we must not accept.
 */

export type OauthStatePayload = { state: string; expiresAt: number };

/** Why a state was refused. Distinct values because they need different advice. */
export type OauthStateFailure = 'missing' | 'unknown' | 'expired' | 'consumed';

export type OauthStateOutcome<T> =
  { ok: true; payload: T } | { ok: false; reason: OauthStateFailure };

export const OAUTH_STATE_MESSAGES: Record<OauthStateFailure, string> = {
  missing: 'The sign-in did not come back with a state parameter. Start the connection again.',
  unknown: 'This connection link is not one we issued. Start the connection again.',
  expired: 'This connection link has expired. Start the connection again.',
  consumed: 'This connection link has already been used. Start the connection again.',
};

function rowKey(prefix: string, state: string) {
  return `${prefix}:${state}`;
}

/**
 * Deletes the flows of this prefix that have timed out.
 *
 * Opportunistic, on create: the payload's expiry lives inside a JSON string, so there is no
 * query that selects expired rows, and a per-flow row would otherwise accumulate one entry
 * per abandoned connect attempt forever. Bounded by the number of concurrent flows, which is
 * the number of admins.
 */
async function pruneExpired(prefix: string) {
  const rows = await prisma.appSetting.findMany({
    where: { key: { startsWith: `${prefix}:` } },
    select: { key: true, value: true },
  });
  const now = Date.now();
  const stale = rows
    .filter((row) => {
      try {
        return (JSON.parse(row.value) as OauthStatePayload).expiresAt < now;
      } catch {
        // Unparseable is unusable, so it is stale by definition.
        return true;
      }
    })
    .map((row) => row.key);
  if (stale.length === 0) return;
  await prisma.appSetting.deleteMany({ where: { key: { in: stale } } });
}

export async function createOauthState<T extends OauthStatePayload>(prefix: string, payload: T) {
  try {
    await pruneExpired(prefix);
  } catch (error) {
    // A failed prune leaves rows behind; it must not stop the operator connecting.
    log.warn('integrations.oauth_state_prune_failed', {
      prefix,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  const key = rowKey(prefix, payload.state);
  const value = JSON.stringify(payload);
  await prisma.appSetting.upsert({
    where: { key },
    create: { key, value },
    update: { value },
  });
  return payload;
}

export async function consumeOauthState<T extends OauthStatePayload>(
  prefix: string,
  state: string | null | undefined,
): Promise<OauthStateOutcome<T>> {
  if (!state) return { ok: false, reason: 'missing' };
  const key = rowKey(prefix, state);
  const row = await prisma.appSetting.findUnique({ where: { key } });
  if (!row) return { ok: false, reason: 'unknown' };
  let payload: T;
  try {
    payload = JSON.parse(row.value) as T;
  } catch {
    return { ok: false, reason: 'unknown' };
  }
  if (payload.state !== state) return { ok: false, reason: 'unknown' };
  if (payload.expiresAt < Date.now()) {
    await consumeRow(key, row.value);
    return { ok: false, reason: 'expired' };
  }
  if (!(await consumeRow(key, row.value))) return { ok: false, reason: 'consumed' };
  return { ok: true, payload };
}
