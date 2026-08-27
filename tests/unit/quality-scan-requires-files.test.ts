import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Task 4: the Quality tab's Scan button took the project lock and charged an audit
 * credit on a project with no `lastCode` and no checkpoints — auditing nothing.
 * `runSeoAudit` / `runCodeAudit` must refuse before the lock and before
 * `checkCredits`, reusing `projectHasPublishableFiles` (the same check Publish uses)
 * rather than a second has-files check — and must not report 'unavailable' (a
 * snapshot that could not be read) as 'empty' (nothing generated yet).
 *
 * Fix round 1 findings 1 & 2: `useSeoAudit`/`useCodeAudit` and `SeoPanel`/
 * `CodeAuditPanel` are client hooks/components with no server-action mock
 * boundary this suite can drive, and this repo has no DOM testing library
 * (`tests/unit/quality-panel-honesty.test.ts` notes the same constraint) — so
 * their part of the fix is verified by source inspection below, the same
 * pattern that file already uses.
 */

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
function readSource(relative: string): string {
  return readFileSync(join(ROOT, relative), 'utf8');
}

const prisma = vi.hoisted(() => ({
  project: { findFirst: vi.fn() },
  codeAudit: { findFirst: vi.fn() },
  seoAudit: { findFirst: vi.fn() },
  job: { findFirst: vi.fn() },
}));
const auth = vi.hoisted(() => ({ getSessionUser: vi.fn() }));
const publishFiles = vi.hoisted(() => ({
  projectHasPublishableFiles: vi.fn(),
  PUBLISH_FILES_UNAVAILABLE:
    "We could not read this project's files from storage. Try again in a few minutes.",
}));
const lock = vi.hoisted(() => ({ holdProjectLock: vi.fn() }));
const credits = vi.hoisted(() => ({ checkCredits: vi.fn() }));

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
vi.mock('@/lib/projects/lock', () => ({ holdProjectLock: lock.holdProjectLock }));
vi.mock('@/lib/plans/limits', () => ({ checkCredits: credits.checkCredits }));
vi.mock('@/lib/audit/scan', () => ({ runCodeScan: vi.fn() }));
vi.mock('@/lib/seo/scan', () => ({ runSeoChecks: vi.fn() }));
vi.mock('@/lib/seo/live', () => ({
  fetchPreviewDocument: vi.fn(),
  fetchPreviewText: vi.fn(),
}));
vi.mock('@/lib/seo/lighthouse', () => ({ runLighthouseSeo: vi.fn() }));

import { runCodeAudit, getLatestCodeAudit } from '@/lib/audit/actions';
import { runSeoAudit, getLatestSeoAudit } from '@/lib/seo/actions';

const USER = { id: 'user-1', role: 'MEMBER' };
const PROJECT = { id: 'p1', ownerId: 'user-1' };

beforeEach(() => {
  vi.clearAllMocks();
  auth.getSessionUser.mockResolvedValue(USER);
  prisma.project.findFirst.mockResolvedValue(PROJECT);
  prisma.job.findFirst.mockResolvedValue(null);
  prisma.codeAudit.findFirst.mockResolvedValue(null);
  prisma.seoAudit.findFirst.mockResolvedValue(null);
  lock.holdProjectLock.mockResolvedValue({ ok: true, release: vi.fn() });
  credits.checkCredits.mockResolvedValue({ ok: true });
});

const RUNS: Array<[string, () => Promise<{ ok: boolean; error?: string; status?: number }>]> = [
  ['runSeoAudit', () => runSeoAudit('p1')],
  ['runCodeAudit', () => runCodeAudit('p1')],
];

describe.each(RUNS)('%s on a project with no files', (_name, run) => {
  it('refuses with the Publish-style hint, and never takes the lock or spends a credit', async () => {
    publishFiles.projectHasPublishableFiles.mockResolvedValue({ status: 'empty' });

    const result = await run();

    expect(result.ok).toBe(false);
    expect(result.error).toBe('Generate the project first');
    expect(result.status).toBe(400);
    expect(lock.holdProjectLock).not.toHaveBeenCalled();
    expect(credits.checkCredits).not.toHaveBeenCalled();
  });

  it('reports an unreadable snapshot as unavailable, distinct from empty, and still refuses', async () => {
    publishFiles.projectHasPublishableFiles.mockResolvedValue({
      status: 'unavailable',
      reason: publishFiles.PUBLISH_FILES_UNAVAILABLE,
    });

    const result = await run();

    expect(result.ok).toBe(false);
    expect(result.error).toBe(publishFiles.PUBLISH_FILES_UNAVAILABLE);
    expect(result.error).not.toBe('Generate the project first');
    expect(result.status).toBe(503);
    expect(lock.holdProjectLock).not.toHaveBeenCalled();
    expect(credits.checkCredits).not.toHaveBeenCalled();
  });

  it('does not refuse a project that has files: it reaches the lock and the credit check', async () => {
    publishFiles.projectHasPublishableFiles.mockResolvedValue({ status: 'ready' });

    // The job-creation pipeline past the credit check is out of scope here (it needs
    // its own heavy mocking, exercised by other suites); this only proves the new
    // guard does not stand between a project that has files and that pipeline.
    await run().catch(() => {});

    expect(lock.holdProjectLock).toHaveBeenCalledTimes(1);
    expect(credits.checkCredits).toHaveBeenCalledTimes(1);
  });
});

describe('getLatestSeoAudit / getLatestCodeAudit hasFiles', () => {
  it('reports hasFiles true and no hint for a ready project', async () => {
    publishFiles.projectHasPublishableFiles.mockResolvedValue({ status: 'ready' });

    const result = await getLatestSeoAudit('p1');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.data.hasFiles).toBe(true);
    expect(result.data.filesHint).toBeNull();
  });

  it('reports hasFiles false with the Publish-style hint for an empty project', async () => {
    publishFiles.projectHasPublishableFiles.mockResolvedValue({ status: 'empty' });

    const result = await getLatestCodeAudit('p1');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.data.hasFiles).toBe(false);
    expect(result.data.filesHint).toBe('Generate the project first');
  });

  it('distinguishes unavailable from empty in the hint text', async () => {
    publishFiles.projectHasPublishableFiles.mockResolvedValue({
      status: 'unavailable',
      reason: publishFiles.PUBLISH_FILES_UNAVAILABLE,
    });

    const result = await getLatestSeoAudit('p1');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.data.hasFiles).toBe(false);
    expect(result.data.filesHint).toBe(publishFiles.PUBLISH_FILES_UNAVAILABLE);
    expect(result.data.filesHint).not.toBe('Generate the project first');
  });
});

describe('Fix round 1, finding 1: exactly one readiness read per Quality-tab open', () => {
  it('SeoPanel / CodeAuditPanel no longer call getLatestSeoAudit / getLatestCodeAudit themselves', () => {
    // Before this fix, each panel made its own extra getLatestSeoAudit/getLatestCodeAudit
    // call — on top of the identical call useSeoAudit/useCodeAudit already makes on mount
    // — just to read the two new hasFiles/filesHint fields. Both calls run
    // projectHasPublishableFiles -> collectPublishFiles, a project query, a checkpoint
    // query and a full snapshot materialisation, so opening the tab paid for that twice.
    const seoPanel = readSource('components/workspace/SeoPanel.tsx');
    const codeAuditPanel = readSource('components/workspace/CodeAuditPanel.tsx');
    expect(seoPanel).not.toMatch(/import\s*\{[^}]*getLatestSeoAudit/);
    expect(seoPanel).not.toMatch(/getLatestSeoAudit\(/);
    expect(codeAuditPanel).not.toMatch(/import\s*\{[^}]*getLatestCodeAudit/);
    expect(codeAuditPanel).not.toMatch(/getLatestCodeAudit\(/);
  });

  it('useSeoAudit / useCodeAudit fold hasFiles/filesHint into their own refresh() and return them', () => {
    const useSeo = readSource('components/workspace/useSeoAudit.ts');
    const useCode = readSource('components/workspace/useCodeAudit.ts');
    for (const src of [useSeo, useCode]) {
      expect(src).toMatch(/setHasFiles\(result\.data\.hasFiles\)/);
      expect(src).toMatch(/setFilesHint\(result\.data\.filesHint\)/);
      expect(src).toMatch(/return\s*\{[^}]*hasFiles[^}]*filesHint[^}]*\}/s);
    }
  });
});

describe('Fix round 1, finding 2: readiness re-checked on something that actually moves', () => {
  it('useSeoAudit / useCodeAudit keep polling while a project has no files yet, not only while scanning', () => {
    // `projectId`/`projectUpdatedAt` never change again once the Quality tab is mounted
    // (projectUpdatedAt is a static server prop), so a project that gains files in-session
    // — e.g. a chat-driven generation finishing while the tab is open — needs a signal that
    // actually moves. The poll interval now also runs while `!hasFiles`, not only while
    // `scanning`, so it notices without a reload and stops once hasFiles flips true.
    const useSeo = readSource('components/workspace/useSeoAudit.ts');
    const useCode = readSource('components/workspace/useCodeAudit.ts');
    for (const src of [useSeo, useCode]) {
      expect(src).toMatch(/!projectId \|\| \(!scanning && hasFiles\)/);
      expect(src).not.toMatch(/if \(!projectId \|\| !scanning\) return;/);
    }
  });
});
