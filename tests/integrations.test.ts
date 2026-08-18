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
  decryptSecretsBlob,
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

assert(INTEGRATION_KINDS.join(',') === 'GITHUB_DEPLOY,CLOUDFLARE,COOLIFY,SENTRY', 'four integration kinds');
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

assert(
  cloudflarePermissionMessage({
    errors: [{ code: 9109, message: 'Token does not have permission to edit DNS records' }],
  }) === 'Zone → DNS → Edit permission missing',
  'DNS Edit named from Cloudflare error',
);
assert(
  cloudflarePermissionMessage({
    errors: [{ message: 'authentication error' }],
    status: 403,
  }) === 'Zone → DNS → Edit permission missing',
  '403 write probe names DNS Edit not generic 403',
);
assert(
  cloudflarePermissionMessage({
    errors: [{ message: 'Unable to authenticate request to list zones' }],
  }) === 'Zone → Zone → Read permission missing',
  'zone list failure names Zone Read',
);

const one = chooseCloudflareZone([
  { id: 'z1', name: 'navroop.app', account: { id: 'a1' } },
]);
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

const secrets = { token: 'cf-secret', pem: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----' };
const blob = encryptSecretsBlob(secrets);
assert(blob.includes('==') || blob.length > 20, 'secrets blob is encrypted');
assert(JSON.parse(decrypt(blob)).token === 'cf-secret', 'blob decrypts via crypto helper');
assert(decryptSecretsBlob(blob).pem?.includes('PRIVATE KEY') === true, 'decryptSecretsBlob restores pem');
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
assert(manifest.setup_url === 'https://app.navroop.app/api/integrations/github/installed', 'setup url');
assert(manifest.public === false, 'app is private');
assert(manifest.default_permissions.contents === 'write', 'contents write');
assert(manifest.default_permissions.administration === 'write', 'administration write');
assert(manifest.default_permissions.metadata === 'read', 'metadata read');
assert(Array.isArray(manifest.default_events) && manifest.default_events.length === 0, 'no events');

assert(hostForSlug('shop', 'LIVE', 'example.com') === 'shop.example.com', 'live host uses zone name');
assert(
  hostForSlug('shop', 'PREVIEW', 'example.com') === 'preview-shop.example.com',
  'preview host uses zone name',
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
