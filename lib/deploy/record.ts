import { prisma } from '@/lib/db';
import {
  DEPLOY_HISTORY_KEY,
  currentRelease,
  parseReleaseHistory,
  pushReleaseHistory,
} from './release';

export async function recordCurrentRelease() {
  try {
    const current = currentRelease({
      ...process.env,
      DEPLOYED_AT: process.env.DEPLOYED_AT || new Date().toISOString(),
    });
    if (!current.sha || current.sha === 'unknown') return;
    const row = await prisma.appSetting.findUnique({
      where: { key: DEPLOY_HISTORY_KEY },
      select: { value: true },
    });
    const history = pushReleaseHistory(parseReleaseHistory(row?.value), current);
    await prisma.appSetting.upsert({
      where: { key: DEPLOY_HISTORY_KEY },
      create: { key: DEPLOY_HISTORY_KEY, value: JSON.stringify(history) },
      update: { value: JSON.stringify(history) },
    });
  } catch {
    // Never block boot.
  }
}
