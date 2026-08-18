import { prisma } from '@/lib/db';
import { createCheckpoint } from '@/lib/checkpoints/actions';
import { WORKSPACE_ROW_ID } from '@/lib/storage/usage';
import { idleMinutes, killSandbox } from './manager';
import { accrueProjectSandboxMinutes } from './meter';
import { EARLY_IDLE_MINUTES } from './minutes';
import { shouldSkipHealthProbe } from './health';
import { getProviderConfig } from './store';
import { SandboxFactory } from './factory';
import {
  clearSandboxLeak,
  getSandboxTeardownLeaks,
  isTeardownLeak,
  recordTeardownIfLeaked,
  teardownProvider,
} from './teardown';

async function providerCircuitOpen(configId: string | null, now: Date) {
  if (!configId) return false;
  const row = await getProviderConfig(configId);
  if (!row) return false;
  const downUntil =
    row.config.downUntil && typeof row.config.downUntil === 'string'
      ? new Date(row.config.downUntil)
      : null;
  return shouldSkipHealthProbe({
    isActive: row.isActive,
    healthStatus: row.healthStatus,
    downUntil,
    now,
  });
}

/**
 * Retry a leaked VM the idle reaper already knows about. Skip when the
 * provider circuit is open so a broken kill path is not hammered every 10 min.
 */
async function retryLeakedSandboxes(now: Date) {
  const leakedProjects = await prisma.project.findMany({
    where: {
      deletedAt: null,
      sandboxId: { not: null },
      sandboxStatus: 'FAILED',
    },
    select: { id: true },
  });

  let retried = 0;
  let stopped = 0;
  for (const project of leakedProjects) {
    const configRows = await prisma.$queryRaw<Array<{ sandboxProviderConfigId: string | null }>>`
      SELECT "sandboxProviderConfigId" FROM "Project" WHERE id = ${project.id} LIMIT 1
    `;
    if (await providerCircuitOpen(configRows[0]?.sandboxProviderConfigId ?? null, now)) continue;
    retried += 1;
    const result = await killSandbox(project.id);
    if (result.stopped) stopped += 1;
  }

  const stored = await getSandboxTeardownLeaks();
  let remaining = stored.open.length;
  for (const leak of stored.open) {
    if (leak.projectId) continue;
    if (await providerCircuitOpen(leak.providerConfigId, now)) continue;
    if (!leak.sandboxId || !leak.providerConfigId) continue;
    const row = await getProviderConfig(leak.providerConfigId);
    if (!row) continue;
    retried += 1;
    const provider = SandboxFactory.fromRow(row);
    try {
      const attached = await provider.reconnect(leak.sandboxId);
      if (!attached) {
        await clearSandboxLeak({ sandboxId: leak.sandboxId });
        remaining -= 1;
        stopped += 1;
        continue;
      }
      const outcome = await teardownProvider(provider);
      if (isTeardownLeak(outcome)) {
        await recordTeardownIfLeaked(outcome, {
          providerConfigId: leak.providerConfigId,
          driver: leak.driver,
          source: leak.source,
        });
        continue;
      }
      await clearSandboxLeak({ sandboxId: leak.sandboxId });
      remaining -= 1;
      stopped += 1;
    } catch (error) {
      console.warn('[reap-sandboxes] leaked test sandbox retry failed', leak.sandboxId, error);
    }
  }

  return { retried, stopped, remaining };
}

export async function reapIdleSandboxes(now = new Date()) {
  const idleCutoff = new Date(now.getTime() - idleMinutes() * 60_000);
  const earlyCutoff = new Date(now.getTime() - EARLY_IDLE_MINUTES * 60_000);

  const live = await prisma.project.findMany({
    where: {
      deletedAt: null,
      OR: [
        { sandboxStatus: { in: ['READY', 'BOOTING'] } },
        { AND: [{ sandboxId: { not: null } }, { sandboxStatus: 'FAILED' }] },
      ],
    },
    select: {
      id: true,
      previewUrl: true,
      sandboxLastUsedAt: true,
      sandboxStatus: true,
      activeJobId: true,
    },
  });

  let accrued = 0;
  for (const project of live) {
    const result = await accrueProjectSandboxMinutes(project.id, WORKSPACE_ROW_ID, now, {
      bumpStart: true,
    });
    accrued += result.minutes;
  }

  const idle = live.filter((project) => {
    if (project.sandboxStatus !== 'READY') return false;
    const lastUsed = project.sandboxLastUsedAt;
    if (!lastUsed) return true;
    if (lastUsed < idleCutoff) return true;
    if (lastUsed < earlyCutoff && !project.activeJobId) return true;
    return false;
  });

  let reaped = 0;
  for (const project of idle) {
    const configRows = await prisma.$queryRaw<Array<{ sandboxProviderConfigId: string | null }>>`
      SELECT "sandboxProviderConfigId" FROM "Project" WHERE id = ${project.id} LIMIT 1
    `;
    if (await providerCircuitOpen(configRows[0]?.sandboxProviderConfigId ?? null, now)) continue;
    const checkpointCount = await prisma.checkpoint.count({ where: { projectId: project.id } });
    if (checkpointCount === 0) {
      try {
        await createCheckpoint(project.id, {
          trigger: 'followup',
          sourceMessage: 'Idle sandbox reap',
          previewUrl: project.previewUrl,
        });
      } catch (error) {
        console.warn('[reap-sandboxes] checkpoint before reap failed', project.id, error);
      }
    }
    try {
      const result = await killSandbox(project.id);
      if (result.stopped) reaped += 1;
    } catch (error) {
      console.warn('[reap-sandboxes] kill failed', project.id, error);
    }
  }

  const leaks = await retryLeakedSandboxes(now);

  return {
    reaped,
    candidates: idle.length,
    accrued,
    leaksRetried: leaks.retried,
    leaksStopped: leaks.stopped,
    leaksRemaining: leaks.remaining,
  };
}
