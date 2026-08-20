import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * F-265 — the deploy App's `webhook_secret` was stored and never used.
 *
 * `convertGithubManifest` returns a `webhook_secret` and the callback persists it into the
 * encrypted secrets blob, but nothing in the repository read it: no webhook route, no
 * signature check, and `default_events: []` on the manifest so GitHub was never asked to
 * deliver anything. The result was a stored credential implying a delivery path that did
 * not exist — so an installation being suspended, a deploy repo being deleted, or a push
 * arriving from elsewhere produced no reaction at all.
 *
 * This module is the part that must be provable without a database: the HMAC check, and the
 * translation of a delivery into effects. It refuses everything it cannot prove. Applying
 * the effects lives in `./github-webhook-effects`.
 */

/** Path the manifest points GitHub at, and the one entry added to the proxy allowlist. */
export const GITHUB_WEBHOOK_ROUTE = '/api/integrations/github/webhook';

/**
 * Events the deploy App subscribes to. Every one of these is interpreted below; nothing is
 * subscribed to "just in case", because an event nobody handles is the state F-265 found.
 */
export const GITHUB_WEBHOOK_EVENTS = [
  'installation',
  'installation_repositories',
  'repository',
  'push',
] as const;

const SIGNATURE_PREFIX = 'sha256=';

/** `sha256=` plus a 64-char hex digest — the exact shape of `X-Hub-Signature-256`. */
const SIGNATURE_SHAPE = /^sha256=[0-9a-f]{64}$/i;

export type GithubSignatureRefusal =
  /** Nothing to verify against: the integration has no `webhookSecret`. */
  | 'no-secret'
  /** No `X-Hub-Signature-256` header at all. */
  | 'no-signature'
  /** Present but not a sha256 hex digest — including the legacy sha1 header. */
  | 'bad-format'
  /** Correctly shaped and wrong: a different secret, or a body that changed. */
  | 'mismatch';

export type GithubSignatureCheck = { ok: true } | { ok: false; reason: GithubSignatureRefusal };

/** The `X-Hub-Signature-256` value GitHub sends for this body and secret. */
export function githubSignature(body: string, secret: string) {
  return SIGNATURE_PREFIX + createHmac('sha256', secret).update(body, 'utf8').digest('hex');
}

export function verifyGithubSignature(input: {
  /** The raw request body, byte for byte as delivered. */
  body: string;
  signature: string | null | undefined;
  secret: string | null | undefined;
}): GithubSignatureCheck {
  const secret = input.secret?.trim();
  if (!secret) return { ok: false, reason: 'no-secret' };
  const supplied = input.signature?.trim();
  if (!supplied) return { ok: false, reason: 'no-signature' };
  if (!SIGNATURE_SHAPE.test(supplied)) return { ok: false, reason: 'bad-format' };
  // Both sides are a fixed-width hex digest by construction, so the lengths always match
  // and `timingSafeEqual` never has to be guarded with a length compare that leaks.
  const expected = Buffer.from(githubSignature(input.body, secret));
  const actual = Buffer.from(supplied.toLowerCase());
  return timingSafeEqual(expected, actual) ? { ok: true } : { ok: false, reason: 'mismatch' };
}

/** Why a delivery led to no action. Recorded so the log distinguishes them. */
export type GithubWebhookIgnoreReason =
  'unhandled-event' | 'unhandled-action' | 'own-push' | 'app-slug-unknown' | 'malformed';

export type GithubRepoUnreachableReason =
  'deleted' | 'renamed' | 'transferred' | 'archived' | 'access-removed';

export type GithubWebhookEffect =
  | { kind: 'ignored'; reason: GithubWebhookIgnoreReason }
  | { kind: 'installation-suspended' }
  | { kind: 'installation-restored' }
  | { kind: 'installation-removed' }
  | {
      kind: 'repo-unreachable';
      /** GitHub's immutable numeric repository id, as a string — see `lib/publish/repo-guard`. */
      repoId: string;
      repoFullName: string | null;
      because: GithubRepoUnreachableReason;
    }
  | {
      kind: 'foreign-push';
      repoId: string;
      repoFullName: string | null;
      ref: string;
      pusher: string;
    };

type RepoRef = { repoId: string; repoFullName: string | null };

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** A repository is identified by its id; the name is for the message, not the match. */
function repoRef(value: unknown): RepoRef | null {
  const repo = record(value);
  const id = repo?.id;
  if (typeof id !== 'number' && typeof id !== 'string') return null;
  const repoId = String(id).trim();
  if (!repoId) return null;
  return { repoId, repoFullName: text(repo?.full_name) };
}

const ignored = (reason: GithubWebhookIgnoreReason): GithubWebhookEffect[] => [
  { kind: 'ignored', reason },
];

const REPO_ACTIONS: Record<string, GithubRepoUnreachableReason> = {
  deleted: 'deleted',
  renamed: 'renamed',
  transferred: 'transferred',
  archived: 'archived',
};

/**
 * Translates one verified delivery into the effects it implies, and nothing more.
 *
 * `appSlug` is the deploy App's slug (`Integration.config.slug`). It exists so a push made
 * with this App's own installation token — sender `<slug>[bot]`, i.e. every publish — is not
 * reported as somebody else's push. Without it a push is left unclassified rather than
 * guessed at.
 */
export function interpretGithubWebhook(input: {
  event: string | null | undefined;
  payload: unknown;
  appSlug?: string | null;
}): GithubWebhookEffect[] {
  const event = text(input.event);
  if (!event || !(GITHUB_WEBHOOK_EVENTS as readonly string[]).includes(event)) {
    return ignored('unhandled-event');
  }
  const payload = record(input.payload);
  if (!payload) return ignored('malformed');
  const action = text(payload.action);

  if (event === 'installation') {
    if (action === 'suspend') return [{ kind: 'installation-suspended' }];
    if (action === 'unsuspend') return [{ kind: 'installation-restored' }];
    if (action === 'deleted') return [{ kind: 'installation-removed' }];
    return ignored('unhandled-action');
  }

  if (event === 'repository') {
    const because = action ? REPO_ACTIONS[action] : undefined;
    if (!because) return ignored('unhandled-action');
    const repo = repoRef(payload.repository);
    if (!repo) return ignored('malformed');
    return [{ kind: 'repo-unreachable', ...repo, because }];
  }

  if (event === 'installation_repositories') {
    if (action !== 'removed') return ignored('unhandled-action');
    const removed = Array.isArray(payload.repositories_removed) ? payload.repositories_removed : [];
    const repos = removed.map(repoRef).filter((repo): repo is RepoRef => repo !== null);
    if (!repos.length) return ignored('malformed');
    return repos.map((repo) => ({
      kind: 'repo-unreachable' as const,
      ...repo,
      because: 'access-removed' as const,
    }));
  }

  // push
  const repo = repoRef(payload.repository);
  const ref = text(payload.ref);
  const pusher = text(record(payload.sender)?.login);
  if (!repo || !ref || !pusher) return ignored('malformed');
  const slug = text(input.appSlug);
  if (!slug) return ignored('app-slug-unknown');
  if (pusher.toLowerCase() === `${slug.toLowerCase()}[bot]`) return ignored('own-push');
  return [{ kind: 'foreign-push', ...repo, ref, pusher }];
}
