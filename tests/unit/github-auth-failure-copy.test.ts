import { describe, expect, it } from 'vitest';
import { GITHUB_REAUTH_MESSAGE, isGitHubAuthFailure } from '@/lib/github/push';

/**
 * A rejected GitHub token has to say what to do about it.
 *
 * Pushing a real generated project failed with GitHub's own wording, "Bad
 * credentials", surfaced verbatim under the button — which reads like the push
 * was malformed and never mentions reconnecting. The connector went on showing
 * CONNECTED, so nothing in the studio disagreed.
 */

describe('GitHub auth failures are recognised', () => {
  it('spots the ways GitHub reports a dead token', () => {
    expect(isGitHubAuthFailure('Bad credentials')).toBe(true);
    expect(isGitHubAuthFailure('Requires authentication')).toBe(true);
    expect(isGitHubAuthFailure('token has expired')).toBe(true);
    expect(isGitHubAuthFailure('Request failed with status 401')).toBe(true);
  });

  it('leaves unrelated failures alone', () => {
    expect(isGitHubAuthFailure('Could not create git tree')).toBe(false);
    expect(isGitHubAuthFailure('name already exists on this account')).toBe(false);
    expect(isGitHubAuthFailure('Could not push to GitHub')).toBe(false);
  });

  it('names the place to fix it', () => {
    expect(GITHUB_REAUTH_MESSAGE).toMatch(/reconnect/i);
    expect(GITHUB_REAUTH_MESSAGE).toMatch(/connectors|configuration/i);
  });
});
