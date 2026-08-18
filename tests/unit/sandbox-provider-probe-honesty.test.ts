import { beforeEach, describe, expect, it, vi } from 'vitest';
import { formatProviderTestResult } from '../../app/(app)/admin/sandbox-providers/provider-test';
import type { StoredProviderConfig } from '../../lib/sandbox/store';

const state = vi.hoisted(() => ({
  rows: [] as StoredProviderConfig[],
  updates: [] as Array<{ id: string; fields: Record<string, unknown> }>,
  provider: {
    createSandbox: async () => ({
      sandboxId: 'sbx-1',
      url: 'https://preview.example.test',
    }),
    runCommand: async () => ({ success: true, exitCode: 0, stdout: 'ok', stderr: '' }),
    terminate: async () => undefined,
    getSandboxUrl: () => 'https://preview.example.test' as string | null,
  },
}));

vi.mock('@/lib/sandbox/store', () => ({
  listProviderConfigs: async () => state.rows,
  updateProviderConfig: async (id: string, fields: Record<string, unknown>) => {
    state.updates.push({ id, fields });
    return fields;
  },
}));

vi.mock('@/lib/sandbox/factory', () => ({
  SandboxFactory: {
    fromRow: () => state.provider,
  },
}));

vi.mock('@/lib/runtime/data-dir', () => ({
  writeCacheJson: () => ({ ok: true }),
}));

vi.mock('@/lib/logger', () => ({
  log: { warn: () => undefined, error: () => undefined },
}));

function stored(
  partial: Partial<StoredProviderConfig> & Pick<StoredProviderConfig, 'id' | 'name' | 'driver'>,
): StoredProviderConfig {
  return {
    isActive: true,
    priority: 10,
    weight: 1,
    secrets: 'not-ciphertext',
    config: { cpu: 1 },
    creditType: 'recurring_monthly',
    creditTotalUsd: 10,
    creditRemainingUsd: 10,
    creditResetsAt: null,
    monthlyBudgetUsd: null,
    monthlyMinutesLimit: null,
    minutesUsed: 0,
    spendUsd: 0,
    periodStart: new Date('2026-08-01T00:00:00.000Z'),
    healthStatus: 'unknown',
    lastCheckedAt: null,
    lastError: null,
    consecutiveFails: 0,
    createdAt: new Date('2026-08-17T00:00:00.000Z'),
    updatedAt: new Date('2026-08-17T00:00:00.000Z'),
    ...partial,
  };
}

const { probeProviderConfigs } = await import('../../lib/sandbox/probe');

describe('probeProviderConfigs honesty vs Test', () => {
  beforeEach(() => {
    state.rows = [];
    state.updates = [];
    state.provider.createSandbox = async () => ({
      sandboxId: 'sbx-1',
      url: 'https://preview.example.test',
    });
    state.provider.runCommand = async () => ({
      success: true,
      exitCode: 0,
      stdout: 'ok',
      stderr: '',
    });
    state.provider.terminate = async () => undefined;
    state.provider.getSandboxUrl = () => 'https://preview.example.test';
  });

  it('writes healthy only when create, echo, shutdown, and a preview URL all succeed', async () => {
    state.rows = [stored({ id: 'modal-1', name: 'Model', driver: 'modal' })];
    const summary = await probeProviderConfigs(new Date('2026-08-18T03:11:00.000Z'));
    expect(summary.results[0]).toMatchObject({ skipped: false, healthy: true });
    expect(state.updates[0]?.fields.healthStatus).toBe('healthy');
    expect(state.updates[0]?.fields.consecutiveFails).toBe(0);
    expect(state.updates[0]?.fields.lastError).toBeNull();
  });

  it('rejects a missing preview URL the same way Test does — not as healthy', async () => {
    state.rows = [stored({ id: 'modal-1', name: 'Model', driver: 'modal' })];
    state.provider.createSandbox = async () => ({ sandboxId: 'sbx-1', url: '' });
    state.provider.getSandboxUrl = () => null;
    await probeProviderConfigs(new Date('2026-08-18T03:11:00.000Z'));
    const expected = formatProviderTestResult({
      driver: 'modal',
      ok: false,
      failedAt: 'preview',
      error: 'Provider did not return a preview URL',
      previewUrl: null,
    });
    expect(state.updates[0]?.fields.healthStatus).toBe('degraded');
    expect(state.updates[0]?.fields.lastError).toBe(expected);
    expect(state.updates[0]?.fields.lastError).toContain('returned no preview URL');
  });

  it('stores the same driver-named English as Test when create throws', async () => {
    state.rows = [stored({ id: 'modal-1', name: 'Model', driver: 'modal' })];
    state.provider.createSandbox = async () => {
      throw new Error('401 unauthorized');
    };
    await probeProviderConfigs(new Date('2026-08-18T03:11:00.000Z'));
    const expected = formatProviderTestResult({
      driver: 'modal',
      ok: false,
      failedAt: 'create',
      error: '401 unauthorized',
      previewUrl: null,
    });
    expect(state.updates[0]?.fields.healthStatus).toBe('degraded');
    expect(state.updates[0]?.fields.lastError).toBe(expected);
    expect(state.updates[0]?.fields.lastError).not.toBe('401 unauthorized');
  });

  it('does not mark healthy when shutdown fails after a clean echo', async () => {
    state.rows = [stored({ id: 'e2b-1', name: 'E2B', driver: 'e2b' })];
    state.provider.terminate = async () => {
      throw new Error('terminate refused');
    };
    await probeProviderConfigs(new Date('2026-08-18T03:11:00.000Z'));
    const expected = formatProviderTestResult({
      driver: 'e2b',
      ok: false,
      failedAt: 'kill',
      error: 'terminate refused',
      previewUrl: 'https://preview.example.test',
    });
    expect(state.updates[0]?.fields.healthStatus).toBe('degraded');
    expect(state.updates[0]?.fields.lastError).toBe(expected);
  });
});
