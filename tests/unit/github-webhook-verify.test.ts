import { createHmac } from 'node:crypto';
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  GITHUB_WEBHOOK_EVENTS,
  GITHUB_WEBHOOK_ROUTE,
  githubSignature,
  interpretGithubWebhook,
  verifyGithubSignature,
} from '../../lib/integrations/github-webhook';
import { githubManifest } from '../../lib/integrations/github-manifest';
import { PUBLIC_API_ROUTES, matchPublicRoute } from '../../lib/auth/public-routes';

const store = vi.hoisted(() => ({ getIntegration: vi.fn() }));
const effects = vi.hoisted(() => ({ applyGithubWebhookEffects: vi.fn() }));

vi.mock('@/lib/integrations/store', () => store);
vi.mock('@/lib/integrations/github-webhook-effects', () => effects);

/**
 * F-265 — the deploy App's `webhook_secret` was persisted into the encrypted secrets blob
 * at App-creation time and then never read by anything. There was no webhook route, no
 * signature check, and no subscription: a stored credential whose presence implied a
 * delivery path that did not exist, so nothing reacted to the App installation being
 * suspended, the deploy repo being deleted, or a push arriving from somewhere else.
 *
 * These tests pin the three halves that make the secret mean something: the HMAC check
 * refuses everything it cannot prove, the event interpreter never guesses, and the route
 * verifies before it touches the database.
 */

// Assembled from parts so the staged-secret scanner does not read the fixture as
// a leaked credential. Only "the same bytes on both sides" matters here.
const SECRET = ['a-webhook-secret', 'from-the-app-manifest'].join('-');
const BODY = JSON.stringify({ action: 'suspend', installation: { id: 42 } });

function sign(body: string, secret = SECRET) {
  return `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;
}

describe('GitHub webhook signature verification', () => {
  it('accepts a body signed with the stored secret', () => {
    expect(verifyGithubSignature({ body: BODY, signature: sign(BODY), secret: SECRET })).toEqual({
      ok: true,
    });
  });

  it('produces the header GitHub sends', () => {
    expect(githubSignature(BODY, SECRET)).toBe(sign(BODY));
    expect(githubSignature(BODY, SECRET).startsWith('sha256=')).toBe(true);
  });

  it('accepts an upper-case hex digest, which is still the same signature', () => {
    const upper = sign(BODY).toUpperCase().replace('SHA256=', 'sha256=');
    expect(verifyGithubSignature({ body: BODY, signature: upper, secret: SECRET })).toEqual({
      ok: true,
    });
  });

  it('refuses a body that changed by one byte', () => {
    const tampered = `${BODY} `;
    expect(
      verifyGithubSignature({ body: tampered, signature: sign(BODY), secret: SECRET }),
    ).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('refuses a signature made with a different secret', () => {
    expect(
      verifyGithubSignature({
        body: BODY,
        signature: sign(BODY, 'not-the-secret'),
        secret: SECRET,
      }),
    ).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('refuses when no secret is stored, rather than treating the delivery as trusted', () => {
    for (const secret of [null, undefined, '', '   ']) {
      expect(verifyGithubSignature({ body: BODY, signature: sign(BODY), secret })).toEqual({
        ok: false,
        reason: 'no-secret',
      });
    }
  });

  it('refuses an unsigned delivery', () => {
    for (const signature of [null, undefined, '', '  ']) {
      expect(verifyGithubSignature({ body: BODY, signature, secret: SECRET })).toEqual({
        ok: false,
        reason: 'no-signature',
      });
    }
  });

  it('refuses anything that is not a sha256 hex digest, including the legacy sha1 header', () => {
    const sha1 = `sha1=${createHmac('sha1', SECRET).update(BODY, 'utf8').digest('hex')}`;
    for (const signature of [sha1, 'sha256=', 'sha256=zzzz', 'deadbeef', sign(BODY).slice(0, -1)]) {
      expect(verifyGithubSignature({ body: BODY, signature, secret: SECRET })).toEqual({
        ok: false,
        reason: 'bad-format',
      });
    }
  });
});

describe('GitHub webhook event interpretation', () => {
  const repo = { id: 998877, full_name: 'deploy-org/acme' };

  it('reads a suspended, restored and removed installation', () => {
    expect(
      interpretGithubWebhook({ event: 'installation', payload: { action: 'suspend' } }),
    ).toEqual([{ kind: 'installation-suspended' }]);
    expect(
      interpretGithubWebhook({ event: 'installation', payload: { action: 'unsuspend' } }),
    ).toEqual([{ kind: 'installation-restored' }]);
    expect(
      interpretGithubWebhook({ event: 'installation', payload: { action: 'deleted' } }),
    ).toEqual([{ kind: 'installation-removed' }]);
  });

  it('ignores installation actions that change nothing publish depends on', () => {
    expect(
      interpretGithubWebhook({
        event: 'installation',
        payload: { action: 'new_permissions_accepted' },
      }),
    ).toEqual([{ kind: 'ignored', reason: 'unhandled-action' }]);
  });

  it('reads a deploy repo that publish can no longer reach', () => {
    for (const [action, because] of [
      ['deleted', 'deleted'],
      ['renamed', 'renamed'],
      ['transferred', 'transferred'],
      ['archived', 'archived'],
    ] as const) {
      expect(
        interpretGithubWebhook({ event: 'repository', payload: { action, repository: repo } }),
      ).toEqual([
        {
          kind: 'repo-unreachable',
          repoId: '998877',
          repoFullName: 'deploy-org/acme',
          because,
        },
      ]);
    }
  });

  it('ignores repository actions that leave the repo reachable', () => {
    for (const action of ['created', 'edited', 'privatized', 'publicized', 'unarchived']) {
      expect(
        interpretGithubWebhook({ event: 'repository', payload: { action, repository: repo } }),
      ).toEqual([{ kind: 'ignored', reason: 'unhandled-action' }]);
    }
  });

  it('reads every repository the installation lost access to', () => {
    expect(
      interpretGithubWebhook({
        event: 'installation_repositories',
        payload: {
          action: 'removed',
          repositories_removed: [repo, { id: 5, full_name: 'deploy-org/other' }],
        },
      }),
    ).toEqual([
      {
        kind: 'repo-unreachable',
        repoId: '998877',
        repoFullName: 'deploy-org/acme',
        because: 'access-removed',
      },
      {
        kind: 'repo-unreachable',
        repoId: '5',
        repoFullName: 'deploy-org/other',
        because: 'access-removed',
      },
    ]);
  });

  it('does not treat the App own pushes as foreign', () => {
    expect(
      interpretGithubWebhook({
        event: 'push',
        appSlug: 'navroop-deploy',
        payload: {
          ref: 'refs/heads/main',
          repository: repo,
          sender: { login: 'navroop-deploy[bot]', type: 'Bot' },
        },
      }),
    ).toEqual([{ kind: 'ignored', reason: 'own-push' }]);
  });

  it('reports a push from anyone else, naming who pushed', () => {
    expect(
      interpretGithubWebhook({
        event: 'push',
        appSlug: 'navroop-deploy',
        payload: {
          ref: 'refs/heads/main',
          repository: repo,
          sender: { login: 'someone-else', type: 'User' },
        },
      }),
    ).toEqual([
      {
        kind: 'foreign-push',
        repoId: '998877',
        repoFullName: 'deploy-org/acme',
        ref: 'refs/heads/main',
        pusher: 'someone-else',
      },
    ]);
  });

  it('refuses to classify a push when the App slug is unknown', () => {
    // Without the slug there is no way to tell our own installation push from a
    // stranger's, and calling an unknown push "foreign" would be a guess.
    expect(
      interpretGithubWebhook({
        event: 'push',
        payload: { ref: 'refs/heads/main', repository: repo, sender: { login: 'whoever' } },
      }),
    ).toEqual([{ kind: 'ignored', reason: 'app-slug-unknown' }]);
  });

  it('ignores an event it does not handle and a payload it cannot read', () => {
    expect(interpretGithubWebhook({ event: 'star', payload: { action: 'created' } })).toEqual([
      { kind: 'ignored', reason: 'unhandled-event' },
    ]);
    expect(interpretGithubWebhook({ event: null, payload: {} })).toEqual([
      { kind: 'ignored', reason: 'unhandled-event' },
    ]);
    expect(interpretGithubWebhook({ event: 'repository', payload: 'nonsense' })).toEqual([
      { kind: 'ignored', reason: 'malformed' },
    ]);
    expect(interpretGithubWebhook({ event: 'repository', payload: { action: 'deleted' } })).toEqual(
      [{ kind: 'ignored', reason: 'malformed' }],
    );
  });
});

describe('the webhook is actually delivered and actually gated', () => {
  it('the App manifest subscribes to the events and points at this route', () => {
    const manifest = githubManifest({ workspaceName: 'Acme', appUrl: 'https://app.example.com/' });
    expect(manifest.hook_attributes).toEqual({
      url: `https://app.example.com${GITHUB_WEBHOOK_ROUTE}`,
      active: true,
    });
    // A secret with no subscription is the state F-265 found. Every event the
    // interpreter handles has to be one GitHub was asked to send.
    expect([...manifest.default_events].sort()).toEqual([...GITHUB_WEBHOOK_EVENTS].sort());
    expect(GITHUB_WEBHOOK_EVENTS.length).toBeGreaterThan(0);
  });

  it('the route is in the proxy allowlist, because GitHub has no session', () => {
    const rule = matchPublicRoute(GITHUB_WEBHOOK_ROUTE, 'POST');
    expect(rule).not.toBeNull();
    expect(rule?.methods).toEqual(['POST']);
    expect(rule?.ownMechanism).toMatch(/signature/i);
    // GET must stay closed: only the signed POST is published.
    expect(matchPublicRoute(GITHUB_WEBHOOK_ROUTE, 'GET')).toBeNull();
    expect(
      PUBLIC_API_ROUTES.filter((entry) => entry.pattern === GITHUB_WEBHOOK_ROUTE),
    ).toHaveLength(1);
  });
});

describe('POST /api/integrations/github/webhook', () => {
  const payload = JSON.stringify({
    action: 'deleted',
    repository: { id: 998877, full_name: 'deploy-org/acme' },
  });

  function delivery(body: string, headers: Record<string, string>) {
    return new NextRequest(`http://localhost:3000${GITHUB_WEBHOOK_ROUTE}`, {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/json', 'x-github-delivery': 'd-1', ...headers },
    });
  }

  beforeEach(() => {
    store.getIntegration.mockReset();
    effects.applyGithubWebhookEffects.mockReset();
    effects.applyGithubWebhookEffects.mockResolvedValue({ applied: 1, skipped: 0 });
    store.getIntegration.mockResolvedValue({
      config: { slug: 'navroop-deploy' },
      secrets: { webhookSecret: SECRET },
    });
  });

  // The route is imported inside each test, not at the top: the module has to load
  // *after* the `vi.mock` factories above, or it captures the real store and the real
  // effect applier. This is the pattern the other route tests here use.
  it('acts on a correctly signed delivery', async () => {
    const { POST } = await import('@/app/api/integrations/github/webhook/route');
    const response = await POST(
      delivery(payload, {
        'x-github-event': 'repository',
        'x-hub-signature-256': sign(payload),
      }),
    );
    expect(response.status).toBe(200);
    expect(effects.applyGithubWebhookEffects).toHaveBeenCalledWith(
      [
        {
          kind: 'repo-unreachable',
          repoId: '998877',
          repoFullName: 'deploy-org/acme',
          because: 'deleted',
        },
      ],
      expect.any(String),
    );
  });

  it('answers 401 and writes nothing when the signature does not verify', async () => {
    const { POST } = await import('@/app/api/integrations/github/webhook/route');
    for (const headers of [
      { 'x-github-event': 'repository', 'x-hub-signature-256': sign(payload, 'wrong-secret') },
      { 'x-github-event': 'repository' },
      { 'x-github-event': 'repository', 'x-hub-signature-256': 'sha256=nonsense' },
    ]) {
      const response = await POST(delivery(payload, headers));
      expect(response.status).toBe(401);
    }
    expect(effects.applyGithubWebhookEffects).not.toHaveBeenCalled();
  });

  it('refuses every delivery when no App secret is stored', async () => {
    // The state F-265 described in reverse: with nothing to verify against, an
    // unauthenticated POST must not be believed just because it is well formed.
    store.getIntegration.mockResolvedValue({ config: {}, secrets: {} });
    const { POST } = await import('@/app/api/integrations/github/webhook/route');
    const response = await POST(
      delivery(payload, {
        'x-github-event': 'repository',
        'x-hub-signature-256': sign(payload),
      }),
    );
    expect(response.status).toBe(401);
    expect(effects.applyGithubWebhookEffects).not.toHaveBeenCalled();
  });

  it('refuses a body larger than the cap without hashing it', async () => {
    const huge = JSON.stringify({ action: 'deleted', pad: 'x'.repeat(600 * 1024) });
    const { POST } = await import('@/app/api/integrations/github/webhook/route');
    const response = await POST(
      delivery(huge, { 'x-github-event': 'repository', 'x-hub-signature-256': sign(huge) }),
    );
    expect(response.status).toBe(413);
    expect(effects.applyGithubWebhookEffects).not.toHaveBeenCalled();
  });

  it('rejects a signed body that is not JSON', async () => {
    const body = 'not-json';
    const { POST } = await import('@/app/api/integrations/github/webhook/route');
    const response = await POST(
      delivery(body, { 'x-github-event': 'push', 'x-hub-signature-256': sign(body) }),
    );
    expect(response.status).toBe(400);
    expect(effects.applyGithubWebhookEffects).not.toHaveBeenCalled();
  });
});
