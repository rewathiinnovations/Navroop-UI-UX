import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createWithFailover, isFailoverError, isSandboxBootFailover } from '@/lib/sandbox/failover';

/**
 * A provider that boots badly must not take the whole instance down with it.
 *
 * `createWithFailover` used to wrap `createSandbox` and nothing else. Creating the VM is
 * the step that almost never fails — the real failure is a vendor handing back a handle and
 * then never serving the dev server. That threw past the loop, so one flaky provider failed
 * every build while the next candidate, a different vendor with credit, was never asked.
 * Observed live: Modal timed out at the readiness poll after 122s and the build settled
 * `sandbox_unavailable`, with an active E2B row sitting next in the list.
 *
 * Two halves: the classifier decides a boot fault is worth another vendor, and the source
 * invariant pins that the boot actually happens inside the loop — the classifier is
 * pointless if the failing steps run after it returns.
 */

const managerSource = readFileSync(join(process.cwd(), 'lib/sandbox/manager.ts'), 'utf8');

function bootError(step: string, message: string, code = 'BOOT_FAILED') {
  const error = new Error(message) as Error & { step: string; code: string };
  error.name = 'SandboxBootError';
  error.step = step;
  error.code = code;
  return error;
}

describe('a boot failure is worth asking the next provider', () => {
  it('fails over on the steps that run after the VM exists', () => {
    for (const step of ['restore', 'install', 'dev', 'ready']) {
      expect(isSandboxBootFailover(bootError(step, 'Preview HTTP 502')), step).toBe(true);
    }
    // The exact shape observed live — and note the base classifier already catches this one
    // on the word "timeout", which is precisely why the missing failover was not a
    // classification bug but a scope bug.
    const observed = bootError(
      'ready',
      'Modal created a sandbox but the preview never became ready (The operation was aborted due to timeout).',
    );
    expect(isSandboxBootFailover(observed)).toBe(true);
    expect(isFailoverError(observed)).toBe(true);

    // A vendor that returns no preview URL says nothing about transport, so only the
    // boot-aware classifier catches it.
    const noUrl = bootError('dev', 'Modal created a sandbox without a preview URL.');
    expect(isSandboxBootFailover(noUrl)).toBe(true);
    expect(isFailoverError(noUrl)).toBe(false);
  });

  it('does not burn the other providers on a fault that repeats everywhere', () => {
    // Ceilings belong to the workspace, not the vendor.
    expect(isSandboxBootFailover(bootError('create', 'Too many sandboxes', 'SANDBOX_LIMIT'))).toBe(false);
    expect(isSandboxBootFailover(bootError('create', 'Out of minutes', 'SANDBOX_MINUTES'))).toBe(false);
    expect(isSandboxBootFailover(bootError('restore', 'No checkpoint', 'NO_CHECKPOINT'))).toBe(false);
    // Not a provider failure at all.
    expect(isSandboxBootFailover(new Error('Provider config missing'))).toBe(false);
  });

  it('reaches the second provider when the first boots badly, and stops at the first success', async () => {
    const tried: string[] = [];
    const result = await createWithFailover<{ url: string }>({
      candidates: [
        { id: 'modal-1', driver: 'modal' },
        { id: 'e2b-1', driver: 'e2b' },
        { id: 'daytona-1', driver: 'daytona' },
      ] as any,
      isFailoverError: isSandboxBootFailover,
      create: async (row) => {
        tried.push(row.driver);
        if (row.driver === 'modal') {
          throw bootError('ready', 'Modal created a sandbox but the preview never became ready.');
        }
        return { url: `https://${row.driver}.preview.test` };
      },
    });

    expect(tried).toEqual(['modal', 'e2b']);
    expect(result.url).toBe('https://e2b.preview.test');
    expect(result.provider.id).toBe('e2b-1');
    expect(result.attempts.map((row) => row.ok)).toEqual([false, true]);
  });
});

describe('the boot runs inside the failover loop', () => {
  // Without this, the classifier above is decoration: the steps it classifies would run
  // after `createWithFailover` has already returned its winner.
  const callback = managerSource.slice(
    managerSource.indexOf('const created = await createWithFailover({'),
    managerSource.indexOf('provider = created.driver;'),
  );

  it('installs, starts the dev server and polls readiness before a provider wins', () => {
    expect(callback).toContain('isFailoverError: (error) => isSandboxBootFailover(error)');
    for (const step of [
      'await driver.installAndStartDev(stack)',
      'await driver.setupViteApp(stack)',
      'await pollPreviewReady(',
      'sandboxCreatedWithoutPreviewUrlMessage(',
    ]) {
      expect(callback, `${step} must run inside the failover callback`).toContain(step);
    }
  });

  it('stops the VM it is abandoning before the next provider is tried', () => {
    // Failing over without this bills the user for every sandbox on the way down the list.
    expect(callback).toContain('await teardownProvider(driver)');
    expect(callback).toMatch(/source: 'boot'/);
  });

  it('leaves the STATIC preview-mode write for the provider that actually won', () => {
    // Written inside the loop it would stick to the project even when the run failed over
    // to a vendor that does serve a public preview.
    const afterLoop = managerSource.slice(managerSource.indexOf('provider = created.driver;'));
    expect(callback).not.toContain('PreviewMode');
    expect(afterLoop).toContain(`UPDATE "Project" SET "previewMode" = 'STATIC'`);
  });
});
