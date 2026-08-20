import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * F-819: a paid background audit that failed surfaced nowhere. The detached
 * runner logged to stdout and failed the AUDIT job, but the poll answered
 * `{ audit: <previous row or null>, scanning: false }` and the client hook
 * cleared its own error on every successful poll — so the user paid, the
 * spinner stopped, and nothing explained why there was no new audit.
 *
 * The fix has two halves. Server: `getLatestCodeAudit` / `getLatestSeoAudit`
 * surface the newest FAILED/ABANDONED AUDIT job as `lastError` unless a newer
 * scan row superseded it (`auditRunFailureMessage`). Client: the hooks set
 * `error` from `lastError` instead of unconditionally clearing it — that is a
 * straight passthrough, so the decision logic tested here IS the hook's
 * behaviour.
 */

const prisma = vi.hoisted(() => ({
  project: { findFirst: vi.fn() },
  codeAudit: { findFirst: vi.fn() },
  seoAudit: { findFirst: vi.fn() },
  job: { findFirst: vi.fn() },
}));
const auth = vi.hoisted(() => ({ getSessionUser: vi.fn() }));

vi.mock('@/lib/db', () => ({ prisma }));
vi.mock('@/lib/auth', () => ({ getSessionUser: auth.getSessionUser }));
vi.mock('@/lib/projects/plan', () => ({
  peekActor: () => null,
  startFollowUpGeneration: vi.fn(),
}));
vi.mock('@/lib/checkpoints/snapshot', () => ({ captureFileSnapshot: vi.fn() }));
vi.mock('@/lib/signals/collect', () => ({
  recordCodeAuditSignals: vi.fn(),
  recordSeoScore: vi.fn(),
}));
vi.mock('@/lib/projects/lock', () => ({ holdProjectLock: vi.fn() }));
vi.mock('@/lib/plans/limits', () => ({ checkCredits: vi.fn() }));
vi.mock('@/lib/audit/scan', () => ({ runCodeScan: vi.fn() }));
vi.mock('@/lib/seo/scan', () => ({ runSeoChecks: vi.fn() }));
vi.mock('@/lib/seo/live', () => ({
  fetchPreviewDocument: vi.fn(),
  fetchPreviewText: vi.fn(),
}));
vi.mock('@/lib/seo/lighthouse', () => ({ runLighthouseSeo: vi.fn() }));

import { getLatestCodeAudit } from '@/lib/audit/actions';
import { getLatestSeoAudit } from '@/lib/seo/actions';
import {
  AUDIT_RUN_FALLBACK_ERROR,
  CODE_AUDIT_STEP,
  SEO_AUDIT_STEP,
  auditRunFailureMessage,
} from '@/lib/audit/poll-state';

const USER = { id: 'user-1', role: 'MEMBER' };
const T0 = new Date('2026-08-20T10:00:00.000Z');
const T1 = new Date('2026-08-20T11:00:00.000Z');

beforeEach(() => {
  vi.clearAllMocks();
  auth.getSessionUser.mockResolvedValue(USER);
  prisma.project.findFirst.mockResolvedValue({ id: 'p1' });
  prisma.job.findFirst.mockResolvedValue(null);
  prisma.codeAudit.findFirst.mockResolvedValue(null);
  prisma.seoAudit.findFirst.mockResolvedValue(null);
});

describe('auditRunFailureMessage', () => {
  it('reports nothing when no audit job ever failed', () => {
    expect(auditRunFailureMessage(T0, null)).toBeNull();
    expect(auditRunFailureMessage(null, null)).toBeNull();
  });

  it('surfaces the failed job message when no scan row exists at all', () => {
    expect(
      auditRunFailureMessage(null, {
        errorMessage: 'Storage read failed',
        finishedAt: T0,
        createdAt: T0,
      }),
    ).toBe('Storage read failed');
  });

  it('surfaces a failure newer than the latest scan row', () => {
    expect(
      auditRunFailureMessage(T0, {
        errorMessage: 'Provider timed out',
        finishedAt: T1,
        createdAt: T1,
      }),
    ).toBe('Provider timed out');
  });

  it('says nothing when a newer scan superseded the failure', () => {
    expect(
      auditRunFailureMessage(T1, {
        errorMessage: 'Provider timed out',
        finishedAt: T0,
        createdAt: T0,
      }),
    ).toBeNull();
  });

  it('falls back to a generic message when the job carries none (abandoned mid-scan)', () => {
    expect(
      auditRunFailureMessage(null, { errorMessage: null, finishedAt: null, createdAt: T0 }),
    ).toBe(AUDIT_RUN_FALLBACK_ERROR);
    expect(
      auditRunFailureMessage(null, { errorMessage: '   ', finishedAt: T0, createdAt: T0 }),
    ).toBe(AUDIT_RUN_FALLBACK_ERROR);
  });
});

describe('getLatestCodeAudit', () => {
  it('returns the failed run message when the newest code-audit job failed after the last row', async () => {
    prisma.job.findFirst.mockResolvedValue({
      errorMessage: 'AI review provider error',
      finishedAt: T1,
      createdAt: T1,
    });

    const result = await getLatestCodeAudit('p1');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.data.scanning).toBe(false);
    expect(result.data.lastError).toBe('AI review provider error');
    expect(prisma.job.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          projectId: 'p1',
          kind: 'AUDIT',
          currentStep: CODE_AUDIT_STEP,
          status: { in: ['FAILED', 'ABANDONED'] },
        }),
      }),
    );
  });

  it('returns lastError null when the latest row is newer than the failure', async () => {
    prisma.codeAudit.findFirst.mockResolvedValue({
      id: 'a1',
      projectId: 'p1',
      findings: [],
      metrics: {},
      scannedAt: T1,
    });
    prisma.job.findFirst.mockResolvedValue({
      errorMessage: 'old failure',
      finishedAt: T0,
      createdAt: T0,
    });

    const result = await getLatestCodeAudit('p1');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.data.lastError).toBeNull();
  });
});

describe('getLatestSeoAudit', () => {
  it('surfaces a failed seo-audit job through the same channel', async () => {
    prisma.job.findFirst.mockResolvedValue({
      errorMessage: 'Lighthouse crashed',
      finishedAt: T1,
      createdAt: T1,
    });

    const result = await getLatestSeoAudit('p1');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.data.lastError).toBe('Lighthouse crashed');
    expect(prisma.job.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ currentStep: SEO_AUDIT_STEP }),
      }),
    );
  });
});
