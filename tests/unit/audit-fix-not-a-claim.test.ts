import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * F-820: `fixCodeFinding` / `fixAllCodeFindings` called `startFollowUpGeneration`
 * — which starts nothing, it only writes a `GenerationEvent` — and then stamped
 * `fixed: true` on the findings, before returning the prompt. The **client**
 * starts the real build afterwards (`CodeAuditPanel.tsx`: `if (result.ok)
 * onSend(...)`). So the panel claimed the issue was fixed while the code was
 * untouched, and the next scan re-reported it as new. Letting the build fail, be
 * cancelled, hit the credit limit, or closing the tab all left the lie in place.
 * The premature event also inflated `followups_to_settle` and the usage-cost
 * roll-up for a generation that had not happened.
 *
 * `markFixed` also re-read `latestRow`, which may be a *newer* audit than the one
 * the caller collected findings from, so flags could land on a different row.
 *
 * The action now records a *request* on the row it actually read, and claims
 * nothing about the outcome.
 */

const db = vi.hoisted(() => ({
  projectFindFirst: vi.fn(),
  codeAuditFindFirst: vi.fn(),
  codeAuditUpdate: vi.fn(),
  seoAuditFindFirst: vi.fn(),
}));
const auth = vi.hoisted(() => ({ getSessionUser: vi.fn() }));
const plan = vi.hoisted(() => ({ peekActor: vi.fn(), startFollowUpGeneration: vi.fn() }));

vi.mock('@/lib/db', () => ({
  prisma: {
    project: { findFirst: db.projectFindFirst },
    codeAudit: { findFirst: db.codeAuditFindFirst, update: db.codeAuditUpdate },
    seoAudit: { findFirst: db.seoAuditFindFirst },
    job: { findFirst: vi.fn() },
  },
}));
vi.mock('@/lib/auth', () => ({ getSessionUser: auth.getSessionUser }));
vi.mock('@/lib/projects/plan', () => ({
  peekActor: plan.peekActor,
  startFollowUpGeneration: plan.startFollowUpGeneration,
}));
vi.mock('@/lib/checkpoints/snapshot', () => ({ captureFileSnapshot: vi.fn() }));
vi.mock('@/lib/preview/url', () => ({ auditPreviewUrl: vi.fn() }));
vi.mock('@/lib/audit/scan', () => ({ runCodeScan: vi.fn() }));
vi.mock('@/lib/signals/collect', () => ({ recordCodeAuditSignals: vi.fn() }));
vi.mock('@/lib/plans/limits', () => ({ checkCredits: vi.fn() }));
vi.mock('@/lib/projects/lock', () => ({ holdProjectLock: vi.fn() }));
vi.mock('@/lib/jobs/step-failure', () => ({ recordJobStepFailure: vi.fn() }));

const FINDING = {
  id: 'f-1',
  title: 'Unused import',
  detail: 'Remove it',
  category: 'lint',
  // `status` carries the severity: 'pass' | 'low' | 'medium' | 'high'.
  status: 'medium',
  fixable: true,
  ignored: false,
};

const AUDIT_ROW = {
  id: 'audit-READ',
  projectId: 'p-1',
  findings: [FINDING],
  metrics: {},
  scannedAt: new Date('2026-02-01'),
};

beforeEach(() => {
  vi.clearAllMocks();
  auth.getSessionUser.mockResolvedValue({ id: 'u-1', role: 'ADMIN', email: 'a@b.c' });
  db.projectFindFirst.mockResolvedValue({ id: 'p-1', ownerId: 'u-1' });
  db.codeAuditFindFirst.mockResolvedValue(AUDIT_ROW);
  db.codeAuditUpdate.mockImplementation(async ({ data }: { data: unknown }) => ({
    ...AUDIT_ROW,
    ...(data as object),
  }));
});

describe('fixCodeFinding records a request, not an outcome', () => {
  it('never stamps a finding fixed — the build has not run yet', async () => {
    const { fixCodeFinding } = await import('@/lib/audit/actions');

    const result = await fixCodeFinding('p-1', 'f-1');

    expect(result.ok).toBe(true);
    const written = db.codeAuditUpdate.mock.calls[0]?.[0] as {
      data: { findings: Array<Record<string, unknown>> };
    };
    const target = written.data.findings.find((item) => item.id === 'f-1');
    expect(target?.fixed).toBeUndefined();
    expect(target?.fixRequestedAt).toEqual(expect.any(String));
  });

  it('does not log a GenerationEvent for a build the client has not started', async () => {
    const { fixCodeFinding } = await import('@/lib/audit/actions');

    await fixCodeFinding('p-1', 'f-1');

    // The real build logs its own event in the generate route. Two rows for one
    // generation inflated followups_to_settle and the usage-cost roll-up.
    expect(plan.startFollowUpGeneration).not.toHaveBeenCalled();
  });

  it('writes to the row it read, not a re-read that may be newer', async () => {
    const { fixCodeFinding } = await import('@/lib/audit/actions');

    await fixCodeFinding('p-1', 'f-1');

    const written = db.codeAuditUpdate.mock.calls[0]?.[0] as { where: { id: string } };
    expect(written.where.id).toBe('audit-READ');
    // One read of the audit row: a second would reintroduce the race where the
    // flags land on a different audit than the findings came from.
    expect(db.codeAuditFindFirst).toHaveBeenCalledTimes(1);
  });

  it('still returns the instruction so the client can start the build', async () => {
    const { fixCodeFinding } = await import('@/lib/audit/actions');

    const result = await fixCodeFinding('p-1', 'f-1');

    if (!result.ok) throw new Error('expected ok');
    expect(result.data.promptContext).toBeTruthy();
    expect(result.data.findingId).toBe('f-1');
  });

  it('refuses a non-owner without writing anything', async () => {
    db.projectFindFirst.mockResolvedValue({ id: 'p-1', ownerId: 'someone-else' });
    auth.getSessionUser.mockResolvedValue({ id: 'u-2', role: 'MEMBER', email: 'm@b.c' });
    const { fixCodeFinding } = await import('@/lib/audit/actions');

    const result = await fixCodeFinding('p-1', 'f-1');

    expect(result.ok).toBe(false);
    expect(db.codeAuditUpdate).not.toHaveBeenCalled();
  });
});
