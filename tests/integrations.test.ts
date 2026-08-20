/**
 * In-app integrations: store, publish guard, Cloudflare zone pick, disconnect.
 * Run: pnpm exec tsx tests/integrations.test.ts
 */
import { resolve } from 'node:path';
import { config } from 'dotenv';
import { encrypt, decrypt } from '../lib/crypto.ts';
import {
  INTEGRATION_KINDS,
  KIND_LABELS,
  chooseCloudflareZone,
  cloudflarePermissionMessage,
  CLOUDFLARE_UNAUTHORIZED_CODE,
  readSecretsBlob,
  disconnectWarning,
  encryptSecretsBlob,
  githubManifest,
  hostForSlug,
  missingIntegrationKinds,
  publishBlockedMessage,
  statusLabel,
} from '../lib/integrations/index.ts';

config({ path: resolve(process.cwd(), '.env.local') });
config({ path: resolve(process.cwd(), '.env') });

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

assert(
  INTEGRATION_KINDS.join(',') === 'GITHUB_DEPLOY,CLOUDFLARE,COOLIFY,SENTRY',
  'four integration kinds',
);
assert(KIND_LABELS.GITHUB_DEPLOY === 'GitHub', 'GitHub label');
assert(KIND_LABELS.CLOUDFLARE === 'Cloudflare', 'Cloudflare label');
assert(KIND_LABELS.COOLIFY === 'Coolify', 'Coolify label');
assert(KIND_LABELS.SENTRY === 'Sentry', 'Sentry label');

assert(statusLabel('CONNECTED') === 'Connected', 'connected pill');
assert(statusLabel('PENDING') === 'Incomplete', 'pending pill');
assert(statusLabel('ERROR') === 'Error', 'error pill');
assert(statusLabel('DISCONNECTED') === 'Not connected', 'disconnected pill');

assert(
  missingIntegrationKinds([]).join(',') === 'GITHUB_DEPLOY,CLOUDFLARE,COOLIFY',
  'empty rows means all missing',
);
assert(
  missingIntegrationKinds([{ kind: 'GITHUB_DEPLOY', status: 'CONNECTED' }]).join(',') ===
    'CLOUDFLARE,COOLIFY',
  'connected GitHub is not missing',
);
assert(
  missingIntegrationKinds([
    { kind: 'GITHUB_DEPLOY', status: 'PENDING' },
    { kind: 'CLOUDFLARE', status: 'CONNECTED' },
    { kind: 'COOLIFY', status: 'ERROR' },
  ]).join(',') === 'GITHUB_DEPLOY,COOLIFY',
  'PENDING and ERROR count as missing',
);
assert(
  missingIntegrationKinds([
    { kind: 'GITHUB_DEPLOY', status: 'CONNECTED' },
    { kind: 'CLOUDFLARE', status: 'CONNECTED' },
    { kind: 'COOLIFY', status: 'CONNECTED' },
  ]).length === 0,
  'all connected is ready',
);

assert(
  publishBlockedMessage(['CLOUDFLARE'], true) === 'Cloudflare is not connected',
  'single missing names Cloudflare',
);
assert(
  publishBlockedMessage(['GITHUB_DEPLOY'], true) === 'GitHub is not connected',
  'single missing names GitHub',
);
assert(
  publishBlockedMessage(['COOLIFY'], true) === 'Coolify is not connected',
  'single missing names Coolify',
);
assert(
  publishBlockedMessage(['GITHUB_DEPLOY', 'CLOUDFLARE'], true) ===
    'GitHub and Cloudflare are not connected',
  'two missing join with and',
);
assert(
  publishBlockedMessage(['GITHUB_DEPLOY'], false) === 'Ask an admin to finish setup',
  'members see admin copy',
);
assert(publishBlockedMessage([], true) === null, 'ready has no block message');

// The advice comes from Cloudflare's 9109 ("Unauthorized to access requested resource")
// plus the call the caller made, never from a bare status or from substrings of the
// message. The middle assertion here used to read "403 write probe names DNS Edit not
// generic 403" and pinned the F-248 defect: it asserted that ANY 403 became DNS Edit
// advice, which is how a rate limit, a suspended account and an IP-restricted token all
// told the admin to add a permission they already had. It now pins the honest behaviour —
// an unrecognised refusal declines so `probeCloudflareDnsEdit` surfaces Cloudflare's own
// sentence.
assert(
  cloudflarePermissionMessage(
    {
      errors: [
        {
          code: CLOUDFLARE_UNAUTHORIZED_CODE,
          message: 'Unauthorized to access requested resource',
        },
      ],
      status: 403,
    },
    'edit-dns',
  ) === 'Zone → DNS → Edit permission missing',
  'DNS Edit named from Cloudflare authorization code',
);
assert(
  cloudflarePermissionMessage(
    { errors: [{ code: 10000, message: 'Authentication error' }], status: 403 },
    'edit-dns',
  ) === null,
  'an unrecognised 403 declines instead of inventing a missing permission',
);
assert(
  cloudflarePermissionMessage(
    {
      errors: [
        {
          code: CLOUDFLARE_UNAUTHORIZED_CODE,
          message: 'Unauthorized to access requested resource',
        },
      ],
      status: 403,
    },
    'list-zones',
  ) === 'Zone → Zone → Read permission missing',
  'the same code on a zone listing names Zone Read',
);

const one = chooseCloudflareZone([{ id: 'z1', name: 'navroop.app', account: { id: 'a1' } }]);
assert(one.status === 'auto' && one.zone?.name === 'navroop.app', 'one zone auto-selects');

const many = chooseCloudflareZone([
  { id: 'z1', name: 'navroop.app', account: { id: 'a1' } },
  { id: 'z2', name: 'example.com', account: { id: 'a1' } },
]);
assert(many.status === 'pick' && many.zones?.length === 2, 'two zones show picker');
assert(chooseCloudflareZone([]).status === 'none', 'no zones');

assert(disconnectWarning(0) === null, 'no warning without live sites');
assert(
  disconnectWarning(3) === '3 live sites are using this connection',
  'disconnect warns with live count',
);

// The PEM header/footer are assembled from parts so the staged-secret scanner does
// not read this fixture as a leaked key. Line 174 asserts the blob does not carry
// the marker in the clear, so the marker itself must still be present here.
const PEM_MARKER = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ');
const PEM_END = ['-----END', 'PRIVATE KEY-----'].join(' ');
const secrets = {
  token: 'cf-secret',
  pem: `${PEM_MARKER}\nabc\n${PEM_END}`,
};
const blob = encryptSecretsBlob(secrets);
// `blob.includes('==') || blob.length > 20` used to stand here: any plaintext JSON
// blob is longer than 20 characters, so it passed on unencrypted output (F-610).
// The property is that neither secret survives in the clear and the blob is not JSON.
assert(!blob.includes('cf-secret'), 'secrets blob does not carry the token in the clear');
assert(!blob.includes('PRIVATE KEY'), 'secrets blob does not carry the pem in the clear');
let blobParsesAsJson = true;
try {
  JSON.parse(blob);
} catch {
  blobParsesAsJson = false;
}
assert(!blobParsesAsJson, 'secrets blob does not parse as the plaintext json it replaced');
assert(JSON.parse(decrypt(blob)).token === 'cf-secret', 'blob decrypts via crypto helper');
const read = readSecretsBlob(blob);
assert(read.unreadable === false, 'a blob written under this key reads back as readable');
assert(read.secrets.pem?.includes('PRIVATE KEY') === true, 'readSecretsBlob restores pem');
// "Nothing stored" and "stored but unreadable" have to be different answers (F-212).
assert(readSecretsBlob(null).unreadable === false, 'an absent blob is readable and empty');
assert(readSecretsBlob('not-ciphertext').unreadable === true, 'a corrupt blob reads as unreadable');
assert(
  Object.keys(readSecretsBlob('not-ciphertext').secrets).length === 0,
  'an unreadable blob yields no secrets',
);
assert(encrypt(JSON.stringify({ a: 1 })) !== JSON.stringify({ a: 1 }), 'encrypt is not plaintext');

const manifest = githubManifest({
  workspaceName: 'Acme',
  appUrl: 'https://app.navroop.app',
  org: 'acme-org',
});
assert(manifest.name === 'Navroop Deploy — Acme', 'manifest name includes workspace');
assert(manifest.url === 'https://app.navroop.app', 'manifest url is APP_URL');
assert(
  manifest.redirect_url === 'https://app.navroop.app/api/integrations/github/callback',
  'manifest redirect is callback',
);
assert(
  manifest.setup_url === 'https://app.navroop.app/api/integrations/github/installed',
  'setup url',
);
assert(manifest.public === false, 'app is private');
assert(manifest.default_permissions.contents === 'write', 'contents write');
assert(manifest.default_permissions.administration === 'write', 'administration write');
assert(manifest.default_permissions.metadata === 'read', 'metadata read');
// F-265: the App now subscribes, so the stored webhook_secret has a delivery to verify.
assert(
  manifest.hook_attributes?.url === 'https://app.navroop.app/api/integrations/github/webhook',
  'manifest points GitHub at the webhook route',
);
assert(manifest.hook_attributes?.active === true, 'webhook deliveries are active');
assert(
  manifest.default_events.includes('installation') &&
    manifest.default_events.includes('repository'),
  'app subscribes to the events the webhook handles',
);

assert(
  hostForSlug('shop', 'LIVE', 'example.com') === 'shop.example.com',
  'live host uses zone name',
);
assert(
  hostForSlug('shop', 'PREVIEW', 'example.com') === 'preview-shop.example.com',
  'preview host uses zone name',
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
