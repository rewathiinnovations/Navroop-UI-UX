import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DaytonaProvider } from '@/lib/sandbox/providers/daytona-provider';
import { E2BProvider } from '@/lib/sandbox/providers/e2b-provider';
import { ModalProvider } from '@/lib/sandbox/providers/modal-provider';
import type { SandboxProvider } from '@/lib/sandbox/types';
import {
  SANDBOX_TEARDOWN_LEAKS_KEY,
  clearSandboxLeak,
  getSandboxTeardownLeaks,
  recordSandboxLeak,
  bindUnusedSandboxOutcome,
  unusedSandboxTeardownSuffix,
  type TeardownResult,
} from '@/lib/sandbox/teardown';
import { sandboxNpmInstallFailedMessage } from '@/lib/sandbox/boot-errors';

/**
 * A failed provider kill used to resolve as success (or get swallowed) and
 * leave a billable VM that nothing in the system could find. A teardown must
 * return stopped / already-gone / could-not-stop, and a leak must be recorded
 * — not a log line.
 */

const settings = new Map<string, string>();
const db = vi.hoisted(() => ({
  project: null as {
    sandboxId: string | null;
    sandboxStartedAt: Date | null;
    sandboxStatus?: string;
    sandboxLastUsedAt?: Date | null;
    previewUrl?: string | null;
    activeJobId?: string | null;
    id?: string;
  } | null,
  projects: [] as Array<{
    id: string;
    previewUrl: string | null;
    sandboxLastUsedAt: Date | null;
    sandboxStatus: string;
    activeJobId: string | null;
    sandboxId?: string | null;
  }>,
  cleared: false,
  executeSql: [] as string[],
}));

vi.mock('@/lib/db', () => {
  const prisma = {
    $executeRaw: async (strings: TemplateStringsArray) => {
      const sql = String.raw({ raw: strings });
      db.executeSql.push(sql);
      if (sql.includes('NONE')) db.cleared = true;
      return 1;
    },
    $queryRaw: async () => [],
    $transaction: async (fn: (tx: typeof prisma) => unknown) => fn(prisma),
    checkpoint: { count: async () => 1 },
    appSetting: {
      findUnique: async ({ where }: { where: { key: string } }) => {
        const value = settings.get(where.key);
        return value == null ? null : { value };
      },
      upsert: async ({
        where,
        create,
        update,
      }: {
        where: { key: string };
        create: { value: string };
        update: { value: string };
      }) => {
        const value = update.value ?? create.value;
        settings.set(where.key, value);
        return { key: where.key, value };
      },
    },
    project: {
      findFirst: async () => db.project,
      findMany: async () => db.projects,
      update: async () => ({}),
      updateMany: async () => ({ count: 0 }),
    },
  };
  return { prisma };
});

vi.mock('@/lib/sandbox/store', () => ({
  getProviderConfig: async () => null,
  listProviderConfigs: async () => [],
  updateProviderConfig: async () => undefined,
}));

vi.mock('@/lib/checkpoints/actions', () => ({
  createCheckpoint: async () => ({ id: 'cp-idle' }),
}));

const { createSandboxOrTerminate, killSandbox } = await import('@/lib/sandbox/manager');
const { sandboxManager } = await import('@/lib/sandbox/sandbox-manager');
const { reapIdleSandboxes } = await import('@/lib/sandbox/reap');

function couldNotStop(reason = 'kill refused', sandboxId = 'sb-leak-1'): TeardownResult {
  return { status: 'could_not_stop', reason, sandboxId };
}

describe('a failed kill must be recorded, not swallowed', () => {
  beforeEach(() => {
    settings.clear();
    db.project = null;
    db.projects = [];
    db.cleared = false;
    db.executeSql = [];
  });

  afterEach(() => {
    settings.clear();
  });

  it('records the leak on AppSetting when create teardown cannot stop the VM', async () => {
    const driver = {
      driver: 'modal',
      createSandbox: async () => {
        throw new Error('image cannot run node');
      },
      terminate: async () => couldNotStop('terminate refused', 'sb-create-leak'),
      getSandboxInfo: () => ({
        sandboxId: 'sb-create-leak',
        url: 'https://preview.example.test',
        provider: 'modal' as const,
        createdAt: new Date(),
      }),
    } as unknown as SandboxProvider;

    await expect(createSandboxOrTerminate(driver, 'NEXTJS')).rejects.toThrow('image cannot run node');

    const leaks = await getSandboxTeardownLeaks();
    expect(leaks.total).toBe(1);
    expect(leaks.open).toEqual([
      expect.objectContaining({
        sandboxId: 'sb-create-leak',
        reason: 'terminate refused',
        driver: 'modal',
        source: 'create',
      }),
    ]);
    expect(settings.has(SANDBOX_TEARDOWN_LEAKS_KEY)).toBe(true);
  });

  it('still throws the original create error — the teardown outcome is additional', async () => {
    const driver = {
      driver: 'e2b',
      createSandbox: async () => {
        throw new Error('encryptedPorts rejected');
      },
      terminate: async () => {
        throw new Error('terminate raced');
      },
      getSandboxInfo: () => ({ sandboxId: 'sb-race', url: '', provider: 'e2b' as const, createdAt: new Date() }),
    } as unknown as SandboxProvider;

    await expect(createSandboxOrTerminate(driver, 'NEXTJS')).rejects.toThrow('encryptedPorts rejected');
    await expect(createSandboxOrTerminate(driver, 'NEXTJS')).rejects.not.toThrow('terminate raced');
  });
});

describe('driver terminate returns a typed outcome instead of swallowing', () => {
  it('E2B reports could_not_stop when sandbox.kill() fails and keeps the handle', async () => {
    const provider = new E2BProvider({ apiKey: 'e2b-not-real' });
    Object.assign(provider, {
      sandbox: {
        sandboxId: 'sb-e2b-leak',
        kill: async () => {
          throw new Error('kill refused');
        },
      },
      sandboxInfo: {
        sandboxId: 'sb-e2b-leak',
        url: 'https://preview.e2b.test',
        provider: 'e2b',
        createdAt: new Date(),
      },
    });

    const outcome = await provider.terminate();
    expect(outcome).toEqual({
      status: 'could_not_stop',
      reason: 'kill refused',
      sandboxId: 'sb-e2b-leak',
    });
    expect(provider.isAlive()).toBe(true);
  });

  it('E2B reports already_gone when kill says the sandbox is not found', async () => {
    const provider = new E2BProvider({ apiKey: 'e2b-not-real' });
    const gone = Object.assign(new Error('Sandbox not found'), { name: 'SandboxNotFoundError', statusCode: 404 });
    Object.assign(provider, {
      sandbox: {
        sandboxId: 'sb-e2b-gone',
        kill: async () => {
          throw gone;
        },
      },
      sandboxInfo: {
        sandboxId: 'sb-e2b-gone',
        url: 'https://preview.e2b.test',
        provider: 'e2b',
        createdAt: new Date(),
      },
    });

    await expect(provider.terminate()).resolves.toEqual({
      status: 'already_gone',
      sandboxId: 'sb-e2b-gone',
    });
    expect(provider.isAlive()).toBe(false);
  });

  it('Modal reports could_not_stop when live.terminate() fails', async () => {
    const provider = new ModalProvider({ tokenId: 'ak-not-real', tokenSecret: 'as-not-real' });
    Object.assign(provider, {
      live: {
        sandboxId: 'sb-modal-leak',
        terminate: async () => {
          throw new Error('terminate refused');
        },
      },
      sandbox: { sandboxId: 'sb-modal-leak' },
      sandboxInfo: {
        sandboxId: 'sb-modal-leak',
        url: 'https://preview.modal.test',
        provider: 'modal',
        createdAt: new Date(),
      },
    });

    await expect(provider.terminate()).resolves.toEqual({
      status: 'could_not_stop',
      reason: 'terminate refused',
      sandboxId: 'sb-modal-leak',
    });
    expect(provider.isAlive()).toBe(true);
  });

  it('Daytona reports could_not_stop when delete() fails', async () => {
    const provider = new DaytonaProvider({ apiKey: 'daytona-not-real' });
    Object.assign(provider, {
      live: {
        id: 'sb-daytona-leak',
        delete: async () => {
          throw new Error('delete refused');
        },
      },
      sandbox: { id: 'sb-daytona-leak' },
      sandboxInfo: {
        sandboxId: 'sb-daytona-leak',
        url: 'https://preview.daytona.test',
        provider: 'daytona',
        createdAt: new Date(),
      },
    });

    await expect(provider.terminate()).resolves.toEqual({
      status: 'could_not_stop',
      reason: 'delete refused',
      sandboxId: 'sb-daytona-leak',
    });
    expect(provider.isAlive()).toBe(true);
  });
});

describe('recordSandboxLeak / clearSandboxLeak', () => {
  beforeEach(() => {
    settings.clear();
  });

  it('upserts an open leak and removes it when the later kill succeeds', async () => {
    await recordSandboxLeak({
      sandboxId: 'sb-open',
      projectId: 'proj-1',
      providerConfigId: 'cfg-1',
      driver: 'e2b',
      reason: 'kill refused',
      source: 'kill',
    });
    expect(await getSandboxTeardownLeaks()).toMatchObject({
      total: 1,
      open: [expect.objectContaining({ sandboxId: 'sb-open', projectId: 'proj-1' })],
    });

    await clearSandboxLeak({ sandboxId: 'sb-open', projectId: 'proj-1' });
    const after = await getSandboxTeardownLeaks();
    expect(after.open).toEqual([]);
    expect(after.total).toBe(1);
  });
});

describe('teardown copy uses the audit vocabulary', () => {
  it('keeps asked-to-stop when there is no outcome, stopped only with evidence, billed when we know it leaked', () => {
    expect(unusedSandboxTeardownSuffix('Modal')).toBe(
      'The unused sandbox was asked to stop. Try again, or ask an admin to test the Modal provider on /admin/sandbox-providers.',
    );
    expect(unusedSandboxTeardownSuffix('Modal', { status: 'stopped', sandboxId: 'sb-1' })).toBe(
      'The unused sandbox was stopped so it is not billed. Try again, or ask an admin to test the Modal provider on /admin/sandbox-providers.',
    );
    expect(
      unusedSandboxTeardownSuffix('Modal', {
        status: 'could_not_stop',
        reason: 'kill refused',
        sandboxId: 'sb-1',
      }),
    ).toBe(
      'The sandbox could not be shut down and may still be billed. Try again, or ask an admin to test the Modal provider on /admin/sandbox-providers.',
    );
  });

  it('keeps the install cause and swaps only the teardown suffix', () => {
    const asked = sandboxNpmInstallFailedMessage('modal', 1, 'npm ERR! ERESOLVE');
    expect(asked).toContain('Modal created a sandbox but npm install failed (exit 1): npm ERR! ERESOLVE.');
    expect(asked).toContain('The unused sandbox was asked to stop.');

    const leaked = sandboxNpmInstallFailedMessage('modal', 1, 'npm ERR! ERESOLVE', {
      status: 'could_not_stop',
      reason: 'kill refused',
      sandboxId: 'sb-1',
    });
    expect(leaked).toContain('Modal created a sandbox but npm install failed (exit 1): npm ERR! ERESOLVE.');
    expect(leaked).toContain('The sandbox could not be shut down and may still be billed.');
    expect(leaked).not.toContain('was asked to stop');
  });

  it('rebinds a placeholder asked-to-stop clause once the outcome exists', () => {
    const asked = unusedSandboxTeardownSuffix('E2B');
    const placeholder = `E2B created a sandbox but did not return a preview URL. ${asked}`;
    const stopped = bindUnusedSandboxOutcome(placeholder, 'E2B', {
      status: 'stopped',
      sandboxId: 'sb-1',
    });
    expect(stopped).toContain('did not return a preview URL');
    expect(stopped).toContain('The unused sandbox was stopped so it is not billed.');
    expect(stopped).not.toContain('was asked to stop');

    const leaked = bindUnusedSandboxOutcome(placeholder, 'E2B', {
      status: 'could_not_stop',
      reason: 'kill refused',
      sandboxId: 'sb-1',
    });
    expect(leaked).toContain('The sandbox could not be shut down and may still be billed.');
    expect(leaked).not.toContain('was asked to stop');
    expect(leaked).not.toContain('is still running');
  });
});

describe('killSandbox keeps a leaked VM findable', () => {
  beforeEach(() => {
    settings.clear();
    db.project = {
      sandboxId: 'sb-kill-leak',
      sandboxStartedAt: new Date('2026-08-18T04:00:00.000Z'),
    };
    db.cleared = false;
    db.executeSql = [];
  });

  it('does not clear sandboxId when terminate cannot stop the VM, and records the leak', async () => {
    const provider = {
      driver: 'modal',
      terminate: async () => couldNotStop('kill refused', 'sb-kill-leak'),
      getSandboxInfo: () => ({
        sandboxId: 'sb-kill-leak',
        url: 'https://preview.example.test',
        provider: 'modal' as const,
        createdAt: new Date(),
      }),
    } as unknown as SandboxProvider;
    sandboxManager.registerSandbox('sb-kill-leak', provider);

    const result = await killSandbox('proj-leak');
    expect(result).toEqual({ stopped: false, leaked: true });
    expect(db.cleared).toBe(false);
    const leaks = await getSandboxTeardownLeaks();
    expect(leaks.open).toEqual([
      expect.objectContaining({
        sandboxId: 'sb-kill-leak',
        projectId: 'proj-leak',
        source: 'kill',
      }),
    ]);
  });

  it('clears the project row only after a confirmed stop', async () => {
    const provider = {
      driver: 'e2b',
      terminate: async () => ({ status: 'stopped' as const, sandboxId: 'sb-kill-leak' }),
      getSandboxInfo: () => ({
        sandboxId: 'sb-kill-leak',
        url: 'https://preview.example.test',
        provider: 'e2b' as const,
        createdAt: new Date(),
      }),
    } as unknown as SandboxProvider;
    sandboxManager.registerSandbox('sb-kill-leak', provider);

    const result = await killSandbox('proj-ok');
    expect(result).toEqual({ stopped: true, leaked: false });
    expect(db.cleared).toBe(true);
  });
});

describe('the idle reaper retries a leaked FAILED sandbox', () => {
  beforeEach(() => {
    settings.clear();
    db.cleared = false;
    db.project = {
      sandboxId: 'sb-failed-leak',
      sandboxStartedAt: new Date('2026-08-18T04:00:00.000Z'),
    };
    db.projects = [
      {
        id: 'proj-failed-leak',
        previewUrl: null,
        sandboxLastUsedAt: new Date('2026-08-18T04:00:00.000Z'),
        sandboxStatus: 'FAILED',
        activeJobId: null,
        sandboxId: 'sb-failed-leak',
      },
    ];
  });

  it('counts a confirmed stop as reaped-from-leak, not as an idle READY kill', async () => {
    const provider = {
      driver: 'daytona',
      terminate: async () => ({ status: 'stopped' as const, sandboxId: 'sb-failed-leak' }),
      getSandboxInfo: () => ({
        sandboxId: 'sb-failed-leak',
        url: 'https://preview.example.test',
        provider: 'daytona' as const,
        createdAt: new Date(),
      }),
    } as unknown as SandboxProvider;
    sandboxManager.registerSandbox('sb-failed-leak', provider);

    const result = await reapIdleSandboxes(new Date('2026-08-18T05:00:00.000Z'));
    expect(result.reaped).toBe(0);
    expect(result.leaksStopped).toBe(1);
    expect(db.cleared).toBe(true);
  });
});
