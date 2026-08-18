import { randomBytes } from 'node:crypto';
import { prisma } from '@/lib/db';
import { consumeRow } from './single-use';

const KEY = 'integration.github.csrf';
const TTL_MS = 10 * 60 * 1000;

type CsrfPayload = {
  state: string;
  org: string;
  userId: string;
  expiresAt: number;
};

export async function createGithubCsrf(org: string, userId: string) {
  const state = randomBytes(24).toString('hex');
  const payload: CsrfPayload = {
    state,
    org: org.trim().replace(/^@/, ''),
    userId,
    expiresAt: Date.now() + TTL_MS,
  };
  await prisma.appSetting.upsert({
    where: { key: KEY },
    create: { key: KEY, value: JSON.stringify(payload) },
    update: { value: JSON.stringify(payload) },
  });
  return payload;
}

export async function consumeGithubCsrf(state: string | null | undefined) {
  if (!state) return null;
  const row = await prisma.appSetting.findUnique({ where: { key: KEY } });
  if (!row) return null;
  let payload: CsrfPayload;
  try {
    payload = JSON.parse(row.value) as CsrfPayload;
  } catch {
    return null;
  }
  if (payload.state !== state || payload.expiresAt < Date.now()) return null;
  if (!(await consumeRow(KEY, row.value))) return null;
  return payload;
}
