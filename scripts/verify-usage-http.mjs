/**
 * Live HTTP acceptance for usage/cost tracking. Does not print secrets.
 *
 *   node scripts/verify-usage-http.mjs
 */
import { config } from 'dotenv';
import { PrismaClient } from '../generated/prisma/index.js';

config({ path: '.env' });
config({ path: '.env.local', override: true });

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const prisma = new PrismaClient();

function cookieHeader(cookies) {
  return cookies.map((c) => c.split(';')[0]).join('; ');
}

function mergeCookies(store, setCookies) {
  for (const raw of setCookies) {
    const [pair] = raw.split(';');
    const eq = pair.indexOf('=');
    store.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
}

function headerFromStore(store) {
  return [...store.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

async function signIn(email, password) {
  const store = new Map();
  const csrfRes = await fetch(`${BASE}/api/auth/csrf`);
  mergeCookies(store, csrfRes.headers.getSetCookie?.() || []);
  const { csrfToken } = await csrfRes.json();
  const body = new URLSearchParams({
    csrfToken,
    email,
    password,
    callbackUrl: BASE,
    json: 'true',
  });
  const signInRes = await fetch(`${BASE}/api/auth/callback/credentials`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      cookie: headerFromStore(store),
    },
    body,
    redirect: 'manual',
  });
  mergeCookies(store, signInRes.headers.getSetCookie?.() || []);
  const me = await fetch(`${BASE}/api/auth/me`, { headers: { cookie: headerFromStore(store) } });
  const meJson = await me.json().catch(() => ({}));
  return { cookie: headerFromStore(store), user: meJson.user || meJson, status: me.status };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

try {
  const adminEmail = process.env.SEED_ADMIN_EMAIL || process.env.ADMIN_EMAIL;
  const adminPassword = process.env.SEED_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD;
  const admin = await signIn(adminEmail, adminPassword);
  assert(admin.status === 200 && admin.user?.role === 'ADMIN', `admin sign-in failed (${admin.status})`);

  const created = await fetch(`${BASE}/api/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: admin.cookie },
    body: JSON.stringify({ initialPrompt: 'usage-http-verify landing page' }),
  });
  const createdJson = await created.json();
  assert(created.ok, `POST /api/projects failed ${created.status} ${JSON.stringify(createdJson)}`);
  const projectId = createdJson.id || createdJson.project?.id;
  assert(projectId, 'createProject response missing id');

  const initialEvents = await prisma.generationEvent.findMany({ where: { projectId } });
  assert(initialEvents.length === 1, `expected exactly 1 initial event, got ${initialEvents.length}`);
  assert(initialEvents[0].kind === 'initial', `expected kind initial, got ${initialEvents[0].kind}`);
  console.log('ok  POST /api/projects → one GenerationEvent kind=initial');

  const follow = await fetch(`${BASE}/api/generate-ai-code-stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: admin.cookie },
    body: JSON.stringify({ prompt: '', isEdit: true, projectId }),
  });
  const followEvents = await prisma.generationEvent.findMany({
    where: { projectId },
    orderBy: { createdAt: 'asc' },
  });
  assert(followEvents.length === 2, `expected 2 events after follow-up, got ${followEvents.length}`);
  assert(followEvents[1].kind === 'followup', `expected kind followup, got ${followEvents[1].kind}`);
  console.log(`ok  POST /api/generate-ai-code-stream isEdit (status ${follow.status}) → one kind=followup`);

  const memberEmail = 'member@navroop.local';
  const memberPassword = 'ChangeMeNow123';
  let memberUser = await prisma.user.findUnique({ where: { email: memberEmail } });
  if (!memberUser) {
    console.log('skip member 403 (demo member missing)');
  } else {
    const member = await signIn(memberEmail, memberPassword);
    assert(member.user?.role === 'MEMBER' || member.status === 200, 'member sign-in failed');
    const paths = [
      '/api/admin/usage/summary',
      '/api/admin/usage/by-member',
      `/api/admin/usage/project/${projectId}`,
    ];
    for (const path of paths) {
      const res = await fetch(`${BASE}${path}`, { headers: { cookie: member.cookie } });
      assert(res.status === 403, `${path} expected 403 for member, got ${res.status}`);
      console.log(`ok  member ${path} → 403`);
    }
  }

  const from = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)).toISOString();
  const to = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 1)).toISOString();
  const qs = `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  const [summaryRes, byMemberRes, projectRes] = await Promise.all([
    fetch(`${BASE}/api/admin/usage/summary?${qs}`, { headers: { cookie: admin.cookie } }),
    fetch(`${BASE}/api/admin/usage/by-member?${qs}`, { headers: { cookie: admin.cookie } }),
    fetch(`${BASE}/api/admin/usage/project/${projectId}`, { headers: { cookie: admin.cookie } }),
  ]);
  const summary = await summaryRes.json();
  const byMember = await byMemberRes.json();
  const projectUsage = await projectRes.json();

  const rows = await prisma.generationEvent.findMany({
    where: { createdAt: { gte: new Date(from), lt: new Date(to) } },
  });
  const manualCost = Math.round(rows.reduce((s, r) => s + Number(r.estimatedCost), 0) * 10000) / 10000;
  const manualProjects = new Set(rows.map((r) => r.projectId)).size;
  assert(summaryRes.status === 200, `summary ${summaryRes.status}`);
  assert(summary.totalGenerations === rows.length, 'summary generations != row count');
  assert(summary.totalProjects === manualProjects, 'summary projects != distinct projectId');
  assert(summary.totalEstimatedCost === manualCost, `summary cost ${summary.totalEstimatedCost} != ${manualCost}`);
  const memberSum = Math.round((byMember.members || []).reduce((s, m) => s + Number(m.estimatedCost), 0) * 10000) / 10000;
  assert(memberSum === manualCost, `by-member cost ${memberSum} != ${manualCost}`);
  assert(projectUsage.events?.length === 2, 'project events should be newest-first pair');
  assert(projectUsage.events[0].kind === 'followup', 'newest event should be followup');
  console.log('ok  admin summary/by-member/project match row sums');

  await prisma.generationEvent.deleteMany({ where: { projectId } });
  await prisma.project.delete({ where: { id: projectId } });
  console.log('\nHTTP usage/cost acceptance passed.');
} finally {
  await prisma.$disconnect();
}
