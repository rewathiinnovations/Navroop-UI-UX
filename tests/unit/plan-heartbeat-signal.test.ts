import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PLAN = fileURLToPath(new URL('../../lib/projects/plan.ts', import.meta.url));
const PLAN_ROUTE = fileURLToPath(
  new URL('../../app/api/projects/[id]/plan/route.ts', import.meta.url),
);
const REFINE_ROUTE = fileURLToPath(
  new URL('../../app/api/projects/[id]/plan/refine/route.ts', import.meta.url),
);
const FOLLOWUP_ROUTE = fileURLToPath(
  new URL('../../app/api/projects/[id]/plan/followup/route.ts', import.meta.url),
);
const FAILOVER = fileURLToPath(new URL('../../lib/ai/plan-complete.ts', import.meta.url));

describe('PLAN heartbeat stops the model when the row goes inactive', () => {
  it('passes request.signal and aborts the model call onInactive', () => {
    const source = readFileSync(PLAN, 'utf8');
    expect(source).toMatch(
      /beginJobHeartbeat\(\s*planJob\.id\s*,\s*\{[\s\S]*signal:[\s\S]*onInactive:/,
    );
    expect(source).toMatch(/onInactive:\s*\(\)\s*=>\s*planCancelled\.abort\(/);
    expect(source).toMatch(/completeWithProviderFailover\(\{[\s\S]*signal:/);
  });

  it('plan routes pass request.signal into the plan action', () => {
    const retry = readFileSync(PLAN_ROUTE, 'utf8');
    const refine = readFileSync(REFINE_ROUTE, 'utf8');
    const followup = readFileSync(FOLLOWUP_ROUTE, 'utf8');
    expect(retry).toMatch(/retryFailedPlan\([^)]*request\.signal/);
    expect(refine).toMatch(/refinePlan\([^)]*request\.signal/);
    expect(followup).toMatch(/requestFollowUpPlan\([^)]*request\.signal/);
  });

  it('the shared failover helper forwards an external abort signal', () => {
    const source = readFileSync(FAILOVER, 'utf8');
    expect(source).toMatch(/signal\?:\s*AbortSignal/);
    expect(source).toMatch(/signal:\s*opts\.signal/);
  });
});
