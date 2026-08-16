import bcrypt from 'bcryptjs';
import { PrismaClient } from '../generated/prisma/index.js';

const BASE = process.env.VERIFY_BASE_URL || 'http://localhost:3000';
const prisma = new PrismaClient();

const MEMBER1 = { email: 'projects-verify-a@navroop.local', password: 'VerifyMember123', name: 'Verify A' };
const MEMBER2 = { email: 'projects-verify-b@navroop.local', password: 'VerifyMember123', name: 'Verify B' };
const ADMIN = { email: 'projects-verify-admin@navroop.local', password: 'VerifyAdmin123', name: 'Verify Admin' };

function mergeCookies(...cookieLists) {
  const jar = new Map();
  for (const list of cookieLists) {
    for (const part of list) {
      const pair = part.split(';')[0];
      const eq = pair.indexOf('=');
      if (eq > 0) jar.set(pair.slice(0, eq), pair.slice(eq + 1));
    }
  }
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

function setCookies(res) {
  return typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
}

async function login(email, password) {
  const csrfRes = await fetch(`${BASE}/api/auth/csrf`);
  const csrfJson = await csrfRes.json();
  const csrfCookies = setCookies(csrfRes);
  const callback = await fetch(`${BASE}/api/auth/callback/credentials`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      cookie: mergeCookies(csrfCookies),
    },
    body: new URLSearchParams({
      csrfToken: csrfJson.csrfToken,
      email,
      password,
      callbackUrl: `${BASE}/dashboard`,
      json: 'true',
    }),
    redirect: 'manual',
  });
  const cookies = mergeCookies(csrfCookies, setCookies(callback));
  const me = await fetch(`${BASE}/api/auth/me`, { headers: { cookie: cookies } });
  const body = await me.json().catch(() => ({}));
  if (!me.ok || !body.user) {
    throw new Error(`login failed for ${email}: callback=${callback.status} me=${me.status} ${JSON.stringify(body)}`);
  }
  return { cookies, user: body.user };
}

async function api(cookies, method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      cookie: cookies,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function ensureUser(account, role) {
  const passwordHash = await bcrypt.hash(account.password, 12);
  const existing = await prisma.user.findUnique({ where: { email: account.email } });
  if (existing) {
    return prisma.user.update({
      where: { id: existing.id },
      data: { passwordHash, role, name: account.name },
    });
  }
  return prisma.user.create({
    data: {
      email: account.email,
      name: account.name,
      passwordHash,
      role,
    },
  });
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const createdIds = [];

try {
  await ensureUser(MEMBER1, 'MEMBER');
  await ensureUser(MEMBER2, 'MEMBER');
  await ensureUser(ADMIN, 'ADMIN');
  const member1 = await login(MEMBER1.email, MEMBER1.password);
  const member2 = await login(MEMBER2.email, MEMBER2.password);
  const admin = await login(ADMIN.email, ADMIN.password);

  const derived = await api(member1.cookies, 'POST', '/api/projects', {
    initialPrompt: 'Build a calm analytics dashboard with KPI cards',
  });
  check(
    'create with only initialPrompt derives a name',
    derived.status === 200 &&
      typeof derived.data.id === 'string' &&
      derived.data.name === 'Build a calm analytics dashboard with KP' &&
      derived.data.initialPrompt === 'Build a calm analytics dashboard with KPI cards' &&
      derived.data.project?.id === derived.data.id,
    `status=${derived.status} name=${derived.data.name}`,
  );
  if (derived.data.id) createdIds.push(derived.data.id);

  const empty = await api(member1.cookies, 'POST', '/api/projects', { initialPrompt: '   ' });
  check(
    'create rejects empty initialPrompt with zod details',
    empty.status === 400 && Array.isArray(empty.data.details),
    `status=${empty.status}`,
  );

  const other = await api(member2.cookies, 'POST', '/api/projects', {
    initialPrompt: 'Member two project for shared workspace',
    name: 'Member two project',
  });
  check('second member can create', other.status === 200 && !!other.data.id, `status=${other.status}`);
  if (other.data.id) createdIds.push(other.data.id);

  const getAsMember1 = await api(member1.cookies, 'GET', `/api/projects/${other.data.id}`);
  const getAsMember2 = await api(member2.cookies, 'GET', `/api/projects/${derived.data.id}`);
  check(
    'two members can GET each other\'s projects',
    getAsMember1.status === 200 &&
      getAsMember1.data.project?.id === other.data.id &&
      getAsMember2.status === 200 &&
      getAsMember2.data.project?.id === derived.data.id,
    `m1=${getAsMember1.status} m2=${getAsMember2.status}`,
  );

  const list = await api(member1.cookies, 'GET', '/api/projects');
  const listedIds = (list.data.projects || []).map((p) => p.id);
  check(
    'list is shared workspace (includes other owner)',
    list.status === 200 && listedIds.includes(other.data.id) && listedIds.includes(derived.data.id),
    `count=${listedIds.length}`,
  );

  const mine = await api(member1.cookies, 'GET', '/api/projects?mine=true');
  const mineIds = (mine.data.projects || []).map((p) => p.id);
  check(
    'mine=true filters to ownerId',
    mine.status === 200 && mineIds.includes(derived.data.id) && !mineIds.includes(other.data.id),
  );

  const forbiddenUpdate = await api(member2.cookies, 'PATCH', `/api/projects/${derived.data.id}`, {
    name: 'Hijacked name',
  });
  const forbiddenDelete = await api(member2.cookies, 'DELETE', `/api/projects/${derived.data.id}`);
  const forbiddenDup = await api(member2.cookies, 'POST', `/api/projects/${derived.data.id}/duplicate`);
  check(
    'non-owner member update/delete/duplicate rejected',
    forbiddenUpdate.status === 403 && forbiddenDelete.status === 403 && forbiddenDup.status === 403,
    `u=${forbiddenUpdate.status} d=${forbiddenDelete.status} dup=${forbiddenDup.status}`,
  );

  const adminUpdate = await api(admin.cookies, 'PATCH', `/api/projects/${derived.data.id}`, {
    name: 'Admin renamed',
    status: 'published',
  });
  check(
    'admin can update someone else\'s project',
    adminUpdate.status === 200 && adminUpdate.data.project?.name === 'Admin renamed',
    `status=${adminUpdate.status}`,
  );

  const adminDelete = await api(admin.cookies, 'DELETE', `/api/projects/${derived.data.id}`);
  const afterDelete = await api(member1.cookies, 'GET', '/api/projects');
  const afterIds = (afterDelete.data.projects || []).map((p) => p.id);
  check(
    'delete then list excludes',
    adminDelete.status === 200 && !afterIds.includes(derived.data.id),
    `status=${adminDelete.status}`,
  );

  const restored = await api(admin.cookies, 'POST', `/api/projects/${derived.data.id}/restore`);
  const afterRestore = await api(member1.cookies, 'GET', '/api/projects');
  const restoreIds = (afterRestore.data.projects || []).map((p) => p.id);
  check(
    'restore brings project back',
    restored.status === 200 && restoreIds.includes(derived.data.id),
    `status=${restored.status}`,
  );

  const ownerDup = await api(member1.cookies, 'POST', `/api/projects/${derived.data.id}/duplicate`);
  check(
    'owner can duplicate (copy name, draft, new owner)',
    ownerDup.status === 200 &&
      ownerDup.data.project?.name === 'Admin renamed (copy)' &&
      ownerDup.data.project?.status === 'draft' &&
      ownerDup.data.project?.ownerId === member1.user?.id,
    `status=${ownerDup.status} name=${ownerDup.data.project?.name}`,
  );
  if (ownerDup.data.project?.id) createdIds.push(ownerDup.data.project.id);
} catch (error) {
  check('script ran without exception', false, String(error));
} finally {
  if (createdIds.length) {
    await prisma.project.deleteMany({ where: { id: { in: createdIds } } });
  }
  await prisma.$disconnect();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
