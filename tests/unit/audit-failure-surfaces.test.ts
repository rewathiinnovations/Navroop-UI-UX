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
 *
 * Fix round 1 (Task 4 finding 3): `getLatestCodeAudit`/`getLatestSeoAudit` also
 * call `auditFilesReadiness` -> `projectHasPublishableFiles` (Task 4's has-files
 * guard) on every poll tick while not scanning. This suite's `prisma` mock has no
 * `checkpoint` model and, until this fix round, did not mock `@/lib/publish/files`
 * either, so that call fell all the way into `collectPublishFiles` and threw. A
 * bare `catch {}` in `auditFilesReadiness` silently turned that real breakage into
 * a normal-looking `{ hasFiles: false, filesHint: <unavailable> }` result, so this
 * suite passed 8/8 while exercising a code path that was entirely broken. The
 * catch now logs (`console.warn`) instead of swallowing silently, and
 * `@/lib/publish/files` is mocked directly below so this suite's assertions about
 * `lastError` are not coupled to `collectPublishFiles`'s own dependencies (which
 * is what broke).
 */

const prisma = vi.hoisted(() => ({
  project: { findFirst: vi.fn() },
  codeAudit: { findFirst: vi.fn() },
  seoAudit: { findFirst: vi.fn() },
  job: { findFirst: vi.fn() },
}));
const auth = vi.hoisted(() => ({ getSessionUser: vi.fn() }));
const publishFiles = vi.hoisted(() => ({
  projectHasPublishableFiles: vi.fn(),
}));

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
vi.mock('@/lib/publish/files', () => publishFiles);
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
  publishFiles.projectHasPublishableFiles.mockResolvedValue({ status: 'ready' });
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

/**
 * Task 4 fix round 1, finding 3: before `@/lib/publish/files` was mocked above,
 * `auditFilesReadiness`'s `projectHasPublishableFiles` call fell through to
 * `collectPublishFiles`, which used `prisma.checkpoint` — a model this suite's
 * `prisma` mock never stubbed — and threw. A bare `catch {}` turned that into a
 * normal-looking `'unavailable'` result, so the two tests below failed before the
 * mock was added: `hasFiles`/`filesHint` came back as the swallowed-error
 * fallback instead of the real answer, and the (until-now silent) catch logged a
 * warning this suite never expected.
 */
describe('getLatestCodeAudit / getLatestSeoAudit readiness path exercises the real dependency', () => {
  it('derives hasFiles/filesHint from a real projectHasPublishableFiles answer, not the swallowed-error fallback', async () => {
    publishFiles.projectHasPublishableFiles.mockResolvedValue({ status: 'empty' });

    const result = await getLatestCodeAudit('p1');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.data.hasFiles).toBe(false);
    expect(result.data.filesHint).toBe('Generate the project first');
  });

  it('does not warn about a swallowed error when the dependency answers normally', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    publishFiles.projectHasPublishableFiles.mockResolvedValue({ status: 'ready' });

    await getLatestCodeAudit('p1');
    await getLatestSeoAudit('p1');

    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
