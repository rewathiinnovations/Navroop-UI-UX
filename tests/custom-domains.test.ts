/**
 * Custom domains: create stays PENDING_DNS, DNS errors name found vs expected,
 * duplicates and free-plan creates are refused, backoff helper.
 * Run: pnpm exec tsx tests/custom-domains.test.ts
 */
import { resolve } from 'node:path';
import { config } from 'dotenv';
import { testPrismaClient } from './setup/db.ts';
import { nextCheckDelayMs, shouldCheckDomain } from '../lib/domains/backoff.ts';
import { createCustomDomain } from '../lib/domains/create.ts';
import { buildDnsInstructions } from '../lib/domains/instructions.ts';
import { checkDomain } from '../lib/domains/verify.ts';

config({ path: resolve(process.cwd(), '.env.local') });
config({ path: resolve(process.cwd(), '.env') });

const prisma = testPrismaClient();

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

const HOUR = 60 * 60 * 1000;
const created = new Date('2026-08-17T12:00:00.000Z');

assert(
  nextCheckDelayMs(created, new Date(created.getTime() + 10 * 60 * 1000)) === 2 * 60 * 1000,
  'backoff is 2 minutes in the first hour',
);
assert(
  nextCheckDelayMs(created, new Date(created.getTime() + 3 * HOUR)) === 15 * 60 * 1000,
  'backoff is 15 minutes in the first day',
);
assert(
  nextCheckDelayMs(created, new Date(created.getTime() + 30 * HOUR)) === HOUR,
  'backoff is hourly after the first day',
);
assert(
  nextCheckDelayMs(created, new Date(created.getTime() + 8 * 24 * HOUR)) === 'failed',
  'backoff marks failed after 7 days',
);
assert(
  shouldCheckDomain(
    created,
    new Date(created.getTime() + 30 * 1000),
    new Date(created.getTime() + 60 * 1000),
  ) === false,
  'does not recheck before the 2 minute window',
);
assert(
  shouldCheckDomain(
    created,
    new Date(created.getTime() + 30 * 1000),
    new Date(created.getTime() + 3 * 60 * 1000),
  ) === true,
  'rechecks after the 2 minute window',
);

const WS = 'ws_custom_domains_test';
const USER = 'user_custom_domains_test';
const PROJECT = 'proj_custom_domains_test';
const SERVER = 'srv_custom_domains_test';
const DEPLOY = 'dep_custom_domains_test';
const ZONE = 'navroop.test';
const SERVER_IP = '203.0.113.10';
const FOUND_IP = '198.51.100.1';
const HOST = 'client.com';
const SLUG = 'acme-site';

try {
  await prisma.$executeRaw`DELETE FROM "CustomDomain" WHERE "workspaceId" = ${WS} OR "hostname" IN (${HOST}, ${'www.client.com'})`;
  await prisma.deployment.deleteMany({ where: { id: DEPLOY } });
  await prisma.coolifyServer.deleteMany({ where: { id: SERVER } });
  await prisma.integration.deleteMany({ where: { workspaceId: WS } });
  await prisma.project.deleteMany({ where: { id: PROJECT } });
  await prisma.workspace.deleteMany({ where: { id: WS } });
  await prisma.user.deleteMany({ where: { id: USER } });
  await prisma.plan.deleteMany({ where: { key: 'custom_domains_test_pro' } });

  const free = await prisma.plan.findFirst({ where: { isDefault: true } });
  assert(Boolean(free), 'default Free plan exists');
  if (!free) throw new Error('Seed the Free plan before running DB assertions');
  assert(free.allowCustomDomain === false, 'free plan allowCustomDomain is false');

  const pro = await prisma.plan.create({
    data: {
      key: 'custom_domains_test_pro',
      name: 'Custom domains test pro',
      monthlyCredits: 1000,
      maxProjects: 10,
      maxLiveSites: 10,
      maxPreviewSites: 10,
      maxMembers: 10,
      checkpointRetentionDays: 7,
      storageBytesLimit: BigInt(1_000_000_000),
      allowCustomDomain: true,
    },
  });

  await prisma.user.create({
    data: {
      id: USER,
      email: 'custom-domains-test@navroop.local',
      name: 'Domains Test',
      passwordHash: 'x',
      role: 'MEMBER',
    },
  });

  await prisma.workspace.create({
    data: {
      id: WS,
      storageBytes: 0,
      planId: free.id,
    },
  });

  await prisma.project.create({
    data: {
      id: PROJECT,
      name: 'Domains Test Project',
      initialPrompt: 'test',
      ownerId: USER,
    },
  });

  await prisma.coolifyServer.create({
    data: {
      id: SERVER,
      name: 'test-server',
      apiUrl: 'https://coolify.test',
      apiToken: 'test-token',
      serverIp: SERVER_IP,
      projectUuid: 'proj-uuid',
    },
  });

  await prisma.deployment.create({
    data: {
      id: DEPLOY,
      projectId: PROJECT,
      workspaceId: WS,
      serverId: SERVER,
      kind: 'LIVE',
      status: 'LIVE',
      slug: SLUG,
      url: `https://${SLUG}.${ZONE}`,
      coolifyAppUuid: 'app-uuid',
      publishedById: USER,
    },
  });

  await prisma.integration.create({
    data: {
      workspaceId: WS,
      kind: 'CLOUDFLARE',
      status: 'CONNECTED',
      config: { zoneId: 'zone_test', zoneName: ZONE, accountId: 'acct_test' },
    },
  });

  const locked = await createCustomDomain({
    projectId: PROJECT,
    hostname: HOST,
    path: 'A',
  });
  assert(locked.ok === false && locked.status === 402, 'free plan refuses create with 402');
  assert(
    locked.ok === false && locked.error === 'This feature is not on your plan yet',
    'free plan lock copy is English',
  );

  await prisma.workspace.update({ where: { id: WS }, data: { planId: pro.id } });

  const createdDomain = await createCustomDomain({
    projectId: PROJECT,
    hostname: HOST,
    path: 'A',
  });
  assert(createdDomain.ok === true, 'create succeeds on a plan that allows custom domains');
  if (!createdDomain.ok) throw new Error(createdDomain.error);

  assert(createdDomain.data.status === 'PENDING_DNS', 'create without DNS stays PENDING_DNS');
  assert(createdDomain.data.hostname === HOST, 'hostname is normalized to client.com');
  assert(
    createdDomain.data.expectedTarget === SERVER_IP,
    'apex expectedTarget is the Coolify server IP',
  );
  assert(createdDomain.data.verifyToken.length >= 16, 'verifyToken is present');

  const rows = buildDnsInstructions(createdDomain.data);
  const aRow = rows.find((row) => row.type === 'A');
  const txtRow = rows.find((row) => row.type === 'TXT');
  assert(aRow?.value === SERVER_IP, 'Path A apex A value is the Coolify server IP');
  assert(aRow?.name === '@' || aRow?.name === HOST, 'Path A apex A name is @ or the hostname');
  assert(txtRow?.name === `_navroop-verify.${HOST}`, 'TXT name is _navroop-verify.client.com');
  assert(txtRow?.value === createdDomain.data.verifyToken, 'TXT value is the verify token');

  const dup = await createCustomDomain({
    projectId: PROJECT,
    hostname: 'https://Client.com/path',
    path: 'A',
  });
  assert(dup.ok === false, 'duplicate hostname is rejected');
  assert(dup.ok === false && /already|duplicate/i.test(dup.error), 'duplicate error is English');

  const checked = await checkDomain(createdDomain.data.id, {
    dns: {
      resolveTxt: async () => ({ status: 'records', records: [[createdDomain.data.verifyToken]] }),
      resolve4: async () => ({ status: 'records', records: [FOUND_IP] }),
      resolveCname: async () => ({ status: 'no-records' }),
    },
    addToCoolify: async () => {
      throw new Error('Coolify should not run when A record is wrong');
    },
  });
  assert(checked.status !== 'ACTIVE', 'wrong A record does not become ACTIVE');
  assert(
    typeof checked.lastError === 'string' && checked.lastError.includes(FOUND_IP),
    'wrong A error names the found IP',
  );
  assert(
    typeof checked.lastError === 'string' && checked.lastError.includes(SERVER_IP),
    'wrong A error names the expected IP',
  );
  assert(
    typeof checked.lastError === 'string' && !/nahi|galat|mil/i.test(checked.lastError),
    'wrong A error is English',
  );
} catch (error) {
  failed += 1;
  console.error('FAIL  db assertions', error);
} finally {
  await prisma.$executeRaw`DELETE FROM "CustomDomain" WHERE "workspaceId" = ${WS} OR "hostname" IN (${HOST}, ${'www.client.com'})`.catch(
    () => undefined,
  );
  await prisma.deployment.deleteMany({ where: { id: DEPLOY } });
  await prisma.coolifyServer.deleteMany({ where: { id: SERVER } });
  await prisma.integration.deleteMany({ where: { workspaceId: WS } });
  await prisma.project.deleteMany({ where: { id: PROJECT } });
  await prisma.workspace.deleteMany({ where: { id: WS } });
  await prisma.user.deleteMany({ where: { id: USER } });
  await prisma.plan.deleteMany({ where: { key: 'custom_domains_test_pro' } });
  await prisma.$disconnect();
}

console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
