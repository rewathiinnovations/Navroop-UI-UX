import { randomBytes } from 'node:crypto';
import { consumeOauthState, createOauthState, type OauthStateOutcome } from './oauth-state';

/**
 * One row per in-flight GitHub App create, keyed by the state value.
 *
 * It used to be a single `integration.github.csrf` row, so two admins connecting at once
 * clobbered each other's nonce and the first callback failed with an unexplained
 * `?reason=state` (F-242).
 */
const PREFIX = 'integration.github.csrf';
const TTL_MS = 10 * 60 * 1000;

export type CsrfPayload = {
  state: string;
  org: string;
  userId: string;
  expiresAt: number;
};

export async function createGithubCsrf(org: string, userId: string) {
  return createOauthState<CsrfPayload>(PREFIX, {
    state: randomBytes(24).toString('hex'),
    org: org.trim().replace(/^@/, ''),
    userId,
    expiresAt: Date.now() + TTL_MS,
  });
}

export async function consumeGithubCsrf(
  state: string | null | undefined,
): Promise<OauthStateOutcome<CsrfPayload>> {
  return consumeOauthState<CsrfPayload>(PREFIX, state);
}
