/**
 * F-013: `proxy.ts` gates pages on cookie *presence* only (`hasSessionCookie`),
 * so `/project/<id>` runs for a stale or garbage cookie. The page must verify
 * the session itself and fetch nothing — before the fix it served
 * `githubRepoUrl` and `phase` into the RSC payload with `session` null.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const authMock = vi.hoisted(() => ({ auth: vi.fn() }));
const dbMock = vi.hoisted(() => ({ projectFindFirst: vi.fn() }));
const githubMock = vi.hoisted(() => ({
  getGitHubConnectionStatusForUser: vi.fn(async () => ({ connected: false as const })),
}));
const planMock = vi.hoisted(() => ({
  getLatestPlan: vi.fn(async () => ({ ok: false as const, error: 'none' })),
}));

vi.mock('@/auth', () => ({ auth: authMock.auth }));
vi.mock('@/lib/db', () => ({ prisma: { project: { findFirst: dbMock.projectFindFirst } } }));
vi.mock('@/lib/github/connection', () => githubMock);
vi.mock('@/lib/projects/plan', () => planMock);
vi.mock('@/components/workspace/GenerationWorkspace', () => ({ default: () => null }));
vi.mock('@/components/workspace/types', () => ({ toWorkspacePlan: vi.fn() }));

import ProjectPage from '@/app/project/[id]/page';

const params = Promise.resolve({ id: 'proj_1' });

describe('/project/[id] requires a verified session', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('redirects without touching project data when the cookie does not decode', async () => {
    authMock.auth.mockResolvedValue(null);
    await expect(ProjectPage({ params })).rejects.toMatchObject({
      digest: expect.stringContaining('NEXT_REDIRECT'),
    });
    expect(dbMock.projectFindFirst).not.toHaveBeenCalled();
    expect(githubMock.getGitHubConnectionStatusForUser).not.toHaveBeenCalled();
    expect(planMock.getLatestPlan).not.toHaveBeenCalled();
  });

  it('renders for a verified member (project reads are workspace-wide)', async () => {
    authMock.auth.mockResolvedValue({ user: { id: 'user_1' } });
    dbMock.projectFindFirst.mockResolvedValue({ githubRepoUrl: null, phase: 'BUILD' });
    await expect(ProjectPage({ params })).resolves.toBeTruthy();
    expect(dbMock.projectFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'proj_1', deletedAt: null } }),
    );
  });
});
