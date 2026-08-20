/**
 * Sentry beforeSend redaction: tokens, pems, passwords, auth headers, query token=,
 * and (F-630) free text in message / exception values / tags / user / breadcrumbs.
 * Run via tests/integration/legacy-suites.test.ts (registered in tests/setup/suites.ts).
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
      githubPem: ['-----BEGIN RSA', ' PRIVATE KEY-----'].join(''),
      secrets: { token: 'integ-secret' },
      safeField: 'ok',
    },
  },
  extra: {
    passwordHash: 'hash',
    pem: ['-----BEGIN', ' PRIVATE KEY-----'].join(''),
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

// F-630: secrets in the places an unhandled exception actually carries them.
// The fake provider tokens are concatenated so the repo secret scanner never
// sees a matchable literal; the runtime strings are the real shapes.
const fakeBearer = 'sk-live-' + 'e2b-key-12345678';
const fakeGithub = 'ghp_' + 'abcdefghijklmnopqrstuv1234';
const dirtyText = {
  request: {},
  extra: {},
  contexts: {},
  message: 'fetch failed: https://cdn.example.com/pull?token=msg-secret-value for user',
  exception: {
    values: [
      {
        type: 'Error',
        value:
          `E2B replied 401: authorization: Bearer ${fakeBearer} — ` +
          'connect postgres://navroop:db-pass-123@db.internal:5432/app ' +
          `pushed with ${fakeGithub}`,
      },
    ],
  },
  tags: {
    apiToken: 'tag-secret-1',
    route: '/dashboard',
    endpoint: 'https://x.test/cb?secret=tag-qs-secret',
  },
  user: { id: 'user_1', sessionToken: 'sess-secret-9' },
  breadcrumbs: [
    {
      message: 'POST https://api.test/hook?key=crumb-msg-secret',
      data: { redirectUrl: 'https://y.test/a?token=crumb-data-secret' },
    },
  ],
};

// The scrubber is shape-preserving, so the typed input literal types the output.
const textScrubbed = sentryBeforeSend(dirtyText, {});
const exValues = textScrubbed.exception.values;
const tags = textScrubbed.tags;
const user = textScrubbed.user;
const crumbs = textScrubbed.breadcrumbs;
const crumbData = crumbs[0]?.data;

assert(!textScrubbed.message.includes('msg-secret-value'), 'message query token scrubbed');
assert(textScrubbed.message.includes('fetch failed'), 'message prose kept');
const exText = exValues[0]?.value ?? '';
assert(exValues[0]?.type === 'Error', 'exception type kept');
assert(exText.includes('E2B replied 401'), 'exception prose kept');
assert(!exText.includes(fakeBearer), 'bearer token scrubbed from exception value');
assert(!exText.includes('db-pass-123'), 'URL userinfo password scrubbed from exception value');
assert(!exText.includes(fakeGithub), 'github token scrubbed from exception value');
assert(tags.apiToken === '[Filtered]', 'sensitive tag key scrubbed');
assert(tags.route === '/dashboard', 'safe tag kept');
assert(
  !tags.endpoint.includes('tag-qs-secret'),
  'query secret scrubbed from non-url-named tag value',
);
assert(user.id === 'user_1', 'user id kept');
assert(user.sessionToken === '[Filtered]', 'user sessionToken scrubbed');
assert(
  typeof crumbs[0]?.message === 'string' && !crumbs[0].message.includes('crumb-msg-secret'),
  'breadcrumb message scrubbed',
);
assert(
  typeof crumbData?.redirectUrl === 'string' &&
    !crumbData.redirectUrl.includes('crumb-data-secret'),
  'breadcrumb redirectUrl query secret scrubbed',
);

const textJson = JSON.stringify(textScrubbed);
assert(!textJson.includes('msg-secret-value'), 'raw message secret not in event');
assert(!textJson.includes('sess-secret-9'), 'raw user token not in event');
assert(!textJson.includes('tag-secret-1'), 'raw tag secret not in event');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
