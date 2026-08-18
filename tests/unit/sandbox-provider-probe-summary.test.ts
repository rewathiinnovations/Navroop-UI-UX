import { describe, expect, it } from 'vitest';
import {
  ALL_PROVIDERS_SKIPPED_NOTE,
  NO_PROVIDERS_CONFIGURED_NOTE,
  summarizeProviderProbe,
} from '../../app/api/cron/check-sandbox-providers/summary';

describe('summarizeProviderProbe', () => {
  it('records a skip instead of passing when every row was skipped', () => {
    const summary = summarizeProviderProbe({
      checked: 0,
      results: [
        { id: 'a', skipped: true },
        { id: 'b', skipped: true },
      ],
    });
    expect(summary.ok).toBe(false);
    expect(summary.skipped).toBe(true);
    expect(summary.error).toBe(ALL_PROVIDERS_SKIPPED_NOTE);
    expect(summary.skippedCount).toBe(2);
    expect(summary.checked).toBe(0);
  });

  it('records a skip when there are no provider rows at all', () => {
    const summary = summarizeProviderProbe({ checked: 0, results: [] });
    expect(summary.ok).toBe(false);
    expect(summary.skipped).toBe(true);
    expect(summary.error).toBe(NO_PROVIDERS_CONFIGURED_NOTE);
  });

  it('stays ok when at least one driver was actually probed', () => {
    const summary = summarizeProviderProbe({
      checked: 2,
      results: [
        { id: 'modal-1', skipped: false, healthy: true },
        { id: 'e2b-1', skipped: false, healthy: false, error: '401 unauthorized' },
        { id: 'daytona-1', skipped: true },
      ],
    });
    expect(summary.ok).toBe(true);
    expect(summary.skipped).toBe(false);
    expect(summary.checked).toBe(2);
    expect(summary.failedCount).toBe(1);
    expect(summary.skippedCount).toBe(1);
  });
});
