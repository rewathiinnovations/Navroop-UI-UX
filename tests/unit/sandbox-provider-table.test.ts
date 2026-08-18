import { describe, expect, it } from 'vitest';
import { toPublicProvider } from '../../lib/sandbox/public';
import type { StoredProviderConfig } from '../../lib/sandbox/store';
import {
  healthLabel,
  providersFromPayload,
  readApiError,
} from '../../app/(app)/admin/sandbox-providers/provider-table';

function stored(partial: Partial<StoredProviderConfig> & Pick<StoredProviderConfig, 'id' | 'name' | 'driver' | 'creditType'>): StoredProviderConfig {
  return {
    isActive: true,
    priority: 100,
    weight: 1,
    secrets: 'not-ciphertext',
    config: { cpu: 1, memoryGiB: 1 },
    creditTotalUsd: 30,
    creditRemainingUsd: 30,
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

/** Same boundary as `NextResponse.json` / the RSC wire. */
function asApiPayload(rows: StoredProviderConfig[]) {
  return JSON.parse(JSON.stringify({
    providers: rows.map(toPublicProvider),
    strategies: [{ id: 'free_first', help: 'help', selected: true }],
    capabilities: [],
  }));
}

describe('sandbox provider table against the real public payload', () => {
  it('paints a row for every toPublicProvider record the API would return', () => {
    const payload = asApiPayload([
      stored({ id: 'modal-1', name: 'Model', driver: 'modal', creditType: 'recurring_monthly' }),
      stored({ id: 'e2b-1', name: 'E2B', driver: 'e2b', creditType: 'one_time', creditRemainingUsd: 98, spendUsd: 0 }),
      stored({ id: 'daytona-1', name: 'Daytona', driver: 'daytona', creditType: 'recurring_monthly' }),
    ]);

    const rows = providersFromPayload(payload);
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.name)).toEqual(['Model', 'E2B', 'Daytona']);
    expect(rows.map((row) => row.driver)).toEqual(['modal', 'e2b', 'daytona']);
    expect(rows.every((row) => row.testLabel === 'Test')).toBe(true);
    expect(rows[0]?.secretLabel).toMatch(/^••••|^$/);
    expect(rows[1]?.creditLabel).toBe('one time');
    expect(rows[0]?.health).toBe('unknown — not checked yet');
    expect(rows[0]?.lastError).toBeNull();
  });

  it('shows the recorded lastError so a green row cannot hide a real failure', () => {
    const payload = asApiPayload([
      stored({
        id: 'modal-1',
        name: 'Model',
        driver: 'modal',
        creditType: 'recurring_monthly',
        healthStatus: 'degraded',
        lastError: 'Modal could not create a sandbox (401 unauthorized). Check the credentials for this provider on /admin/sandbox-providers.',
      }),
    ]);
    const rows = providersFromPayload(payload);
    expect(rows[0]?.health).toBe('degraded — last create/echo/shutdown failed');
    expect(rows[0]?.lastError).toContain('401 unauthorized');
    expect(rows[0]?.lastError).toContain('Check the credentials');
  });

  it('emits a serialisable monthsRemaining so an unused one-time pool does not produce Infinity', () => {
    const publicRow = toPublicProvider(
      stored({ id: 'e2b-1', name: 'E2B', driver: 'e2b', creditType: 'one_time', creditRemainingUsd: 98, spendUsd: 0 }),
    );
    expect(publicRow.monthsRemaining).toBeNull();
    const rows = providersFromPayload(asApiPayload([
      stored({ id: 'e2b-1', name: 'E2B', driver: 'e2b', creditType: 'one_time', creditRemainingUsd: 98, spendUsd: 0 }),
    ]));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.monthsRemaining).toBeNull();
    expect(rows[0]?.monthsLabel).toBe('');
  });

  it('does not throw when secretsMasked is missing from a row', () => {
    expect(() =>
      providersFromPayload({
        providers: [{ id: 'x', name: 'Broken', driver: 'e2b', creditType: 'paid', healthStatus: 'unknown' }],
      }),
    ).not.toThrow();
    const rows = providersFromPayload({
      providers: [{ id: 'x', name: 'Broken', driver: 'e2b', creditType: 'paid', healthStatus: 'unknown' }],
    });
    expect(rows[0]?.name).toBe('Broken');
    expect(rows[0]?.secretLabel).toBe('••••');
  });
});

describe('healthLabel', () => {
  it('does not leave unknown looking like a probe result', () => {
    expect(healthLabel('unknown')).toBe('unknown — not checked yet');
  });

  it('does not let healthy mean a preview or a build was proven', () => {
    expect(healthLabel('healthy')).toBe('healthy — create, echo, and shutdown succeeded');
    expect(healthLabel('healthy')).not.toMatch(/preview|build/i);
    expect(healthLabel('degraded')).toBe('degraded — last create/echo/shutdown failed');
    expect(healthLabel('down')).toBe('down — circuit open after 3 failures');
  });
});

describe('readApiError', () => {
  it('reads the envelope object so React is not asked to render one', () => {
    expect(readApiError({ error: { message: 'Sign in required', code: 'UNAUTHORIZED' } }, 'fallback')).toBe(
      'Sign in required',
    );
    expect(readApiError({ error: 'Name is required' }, 'fallback')).toBe('Name is required');
  });
});
