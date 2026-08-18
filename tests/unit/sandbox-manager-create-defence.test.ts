import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { SandboxInfo, SandboxProvider } from '@/lib/sandbox/types';

vi.mock('@/lib/db', () => {
  const prisma = {
    project: { findFirst: async () => null, update: async () => ({}) },
    $queryRaw: async () => [],
    $executeRaw: async () => 1,
    $transaction: async (fn: (tx: unknown) => unknown) => fn(prisma),
    appSetting: {
      findUnique: async () => null,
      upsert: async () => ({ key: 'sandbox.teardownLeaks', value: '{"total":0,"open":[]}' }),
    },
  };
  return { prisma };
});

const {
  applySandboxBootTeardownOutcome,
  createSandboxOrTerminate,
  SandboxBootError,
  sandboxCreatedWithoutPreviewUrlMessage,
} = await import('@/lib/sandbox/manager');

/**
 * Pins the two manager.ts create-path defences. Does not boot ensureSandbox,
 * selectProvider, or claimBoot — those stay owned by the lost-claim suite.
 */

const managerSource = readFileSync(join(process.cwd(), 'lib/sandbox/manager.ts'), 'utf8');

describe('manager last-resort preview URL copy', () => {
  it('names the driver so a leftover empty URL is not anonymous', () => {
    expect(sandboxCreatedWithoutPreviewUrlMessage('modal')).toBe(
      'Modal created a sandbox without a preview URL. The unused sandbox was asked to stop. Try again, or ask an admin to test the Modal provider on /admin/sandbox-providers.',
    );
    expect(managerSource).toMatch(
      /sandboxCreatedWithoutPreviewUrlMessage\(\s*selectedConfig\.driver\s*\)/,
    );
    expect(managerSource).not.toMatch(
      /SandboxBootError\(\s*'dev',\s*'Sandbox created without a preview URL'/,
    );
  });

  it('threads a proven stop or leak into the leftover-URL sentence after teardown', () => {
    expect(
      sandboxCreatedWithoutPreviewUrlMessage('modal', { status: 'stopped', sandboxId: 'sb-1' }),
    ).toBe(
      'Modal created a sandbox without a preview URL. The unused sandbox was stopped so it is not billed. Try again, or ask an admin to test the Modal provider on /admin/sandbox-providers.',
    );
    const leaked = sandboxCreatedWithoutPreviewUrlMessage('e2b', {
      status: 'could_not_stop',
      reason: 'kill refused',
      sandboxId: 'sb-1',
    });
    expect(leaked).toContain('E2B created a sandbox without a preview URL.');
    expect(leaked).toContain('The sandbox could not be shut down and may still be billed.');
    expect(leaked).not.toContain('was asked to stop');
  });

  it('rebinds poll and leftover-URL copy once boot teardown has an outcome', () => {
    const poll = new SandboxBootError(
      'ready',
      'Modal created a sandbox but the preview never became ready (Preview HTTP 502). The unused sandbox was asked to stop. Try again, or ask an admin to test the Modal provider on /admin/sandbox-providers.',
      { previewLastError: 'Preview HTTP 502' },
    );
    const stopped = applySandboxBootTeardownOutcome(poll, 'modal', {
      status: 'stopped',
      sandboxId: 'sb-1',
    });
    expect(stopped).toContain('the preview never became ready (Preview HTTP 502)');
    expect(stopped).toContain('The unused sandbox was stopped so it is not billed.');
    expect(stopped).not.toContain('was asked to stop');

    const leak = applySandboxBootTeardownOutcome(
      new SandboxBootError('dev', sandboxCreatedWithoutPreviewUrlMessage('daytona')),
      'daytona',
      { status: 'could_not_stop', reason: 'delete refused', sandboxId: 'sb-1' },
    );
    expect(leak).toContain('Daytona created a sandbox without a preview URL.');
    expect(leak).toContain('The sandbox could not be shut down and may still be billed.');
    expect(leak).not.toContain('was asked to stop');

    expect(managerSource).toMatch(/applySandboxBootTeardownOutcome\(/);
  });
});

describe('createSandboxOrTerminate', () => {
  it('returns the created info and does not terminate on success', async () => {
    const info: SandboxInfo = {
      sandboxId: 'sb-ok',
      url: 'https://preview.example.com',
      provider: 'modal',
      createdAt: new Date(),
    };
    const terminate = async () => {
      throw new Error('terminate must not run on a successful create');
    };
    const driver = {
      createSandbox: async () => info,
      terminate,
    } as unknown as SandboxProvider;

    await expect(createSandboxOrTerminate(driver, 'NEXTJS')).resolves.toEqual(info);
  });

  it('terminates the driver before rethrowing when createSandbox throws', async () => {
    const order: string[] = [];
    const driver = {
      createSandbox: async () => {
        order.push('create');
        throw new Error('encryptedPorts rejected');
      },
      terminate: async () => {
        order.push('terminate');
      },
    } as unknown as SandboxProvider;

    await expect(createSandboxOrTerminate(driver, 'NEXTJS')).rejects.toThrow(
      'encryptedPorts rejected',
    );
    expect(order).toEqual(['create', 'terminate']);
  });

  it('still rethrows the create error when terminate itself fails', async () => {
    const driver = {
      createSandbox: async () => {
        throw new Error('image cannot run node');
      },
      terminate: async () => {
        throw new Error('terminate raced');
      },
    } as unknown as SandboxProvider;

    await expect(createSandboxOrTerminate(driver, 'NEXTJS')).rejects.toThrow(
      'image cannot run node',
    );
  });

  it('is the create callback used by bootProject, so a thrown create is not dropped', () => {
    expect(managerSource).toMatch(/createSandboxOrTerminate\(\s*driver,\s*stack\s*\)/);
  });
});
