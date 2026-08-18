import { nextHealthAfterFailure, nextHealthAfterSuccess } from '@/lib/sandbox/health';
import {
  formatProviderCheckResult,
  type LeakedTestSandbox,
} from '@/lib/sandbox/provider-check-copy';

export const TEST_SCOPE =
  'Test creates a sandbox, runs echo, and shuts it down. It does not start a preview or run a build.';

export type ProviderTestView = {
  driver: string;
  ok: boolean;
  failedAt: string | null;
  error: string | null;
  previewUrl: string | null;
  leakedSandbox?: LeakedTestSandbox | null;
};

export function formatProviderTestResult(view: ProviderTestView): string {
  return formatProviderCheckResult(view);
}

export function fieldsAfterProviderTest(input: {
  ok: boolean;
  consecutiveFails: number;
  lastError: string | null;
  config: Record<string, unknown>;
  now: Date;
}) {
  if (input.ok) {
    const next = nextHealthAfterSuccess();
    const config = { ...input.config };
    delete config.downUntil;
    return {
      healthStatus: next.healthStatus,
      consecutiveFails: 0,
      lastCheckedAt: input.now,
      lastError: null,
      config,
    };
  }
  const next = nextHealthAfterFailure(input.consecutiveFails, input.now);
  const config = { ...input.config };
  if (next.downUntil) config.downUntil = next.downUntil.toISOString();
  return {
    healthStatus: next.healthStatus,
    consecutiveFails: next.consecutiveFails,
    lastCheckedAt: input.now,
    lastError: (input.lastError ?? 'Provider test failed').slice(0, 500),
    config,
  };
}
