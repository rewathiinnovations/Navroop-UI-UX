/**
 * Sentry beforeSend redaction: tokens, pems, passwords, auth headers, query token=.
 * Run: npx tsx tests/sentry-scrub.test.ts
 */
import { sentryBeforeSend } from '../lib/sentry/scrub.ts';

let failed = 0;
let passed = 0;

function assert(cond: unknown, name: string) {
  if (cond) {
    passed += 1;
    console.log(`PASS  ${name}`);
    return;
  }
  failed += 1;
  console.error(`FAIL  ${name}`);
}

function eventWith(partial: Record<string, unknown>) {
  return {
    request: {},
    extra: {},
    contexts: {},
    ...partial,
  } as Parameters<typeof sentryBeforeSend>[0];
}

const dirty = eventWith({
  request: {
    url: 'https://navroop.app/reset-password?token=super-secret-reset&next=/dashboard',
    headers: {
      authorization: 'Bearer sk-live-abc',
      cookie: 'authjs.session-token=sess',
      'content-type': 'application/json',
    },
    query_string: 'token=super-secret-reset&next=/dashboard',
    data: {
      password: 'hunter2',
      resetToken: 'abc123',
      apiKey: 'cf-key',
      cloudflareToken: 'cf-token',
      coolifyToken: 'cool-token',
      githubPem: '-----BEGIN RSA PRIVATE KEY-----',
      secrets: { token: 'integ-secret' },
      safeField: 'ok',
    },
  },
  extra: {
    passwordHash: 'hash',
    pem: '-----BEGIN PRIVATE KEY-----',
    note: 'visible',
  },
});

const scrubbed = sentryBeforeSend(dirty, {});
const req = (scrubbed?.request ?? {}) as Record<string, unknown>;
const headers = (req.headers ?? {}) as Record<string, string>;
const data = (req.data ?? {}) as Record<string, unknown>;
const extra = (scrubbed?.extra ?? {}) as Record<string, unknown>;

assert(Boolean(scrubbed), 'beforeSend returns an event');
assert(headers.authorization === '[Filtered]', 'authorization header scrubbed');
assert(headers.cookie === '[Filtered]', 'cookie header scrubbed');
assert(headers['content-type'] === 'application/json', 'safe header kept');
assert(data.password === '[Filtered]', 'password body field scrubbed');
assert(data.resetToken === '[Filtered]', 'resetToken body field scrubbed');
assert(data.apiKey === '[Filtered]', 'apiKey body field scrubbed');
assert(data.cloudflareToken === '[Filtered]', 'cloudflareToken body field scrubbed');
assert(data.coolifyToken === '[Filtered]', 'coolifyToken body field scrubbed');
assert(data.githubPem === '[Filtered]', 'githubPem body field scrubbed');
assert(data.secrets === '[Filtered]', 'secrets body field scrubbed');
assert(data.safeField === 'ok', 'unrelated body field kept');
assert(extra.passwordHash === '[Filtered]', 'extra passwordHash scrubbed');
assert(extra.pem === '[Filtered]', 'extra pem scrubbed');
assert(extra.note === 'visible', 'unrelated extra kept');
assert(
  typeof req.url === 'string' && !String(req.url).includes('super-secret-reset'),
  'reset-password token query param scrubbed from url',
);
assert(
  typeof req.query_string === 'string' && !String(req.query_string).includes('super-secret-reset'),
  'token= query string scrubbed',
);

const json = JSON.stringify(scrubbed);
assert(!json.includes('sk-live-abc'), 'raw bearer token not in event');
assert(!json.includes('hunter2'), 'raw password not in event');
assert(!json.includes('-----BEGIN'), 'pem material not in event');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
