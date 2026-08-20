import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * F-823: `adminGenerateThumbnails` looped over *every* built-in template lacking
 * a thumbnail and, per iteration, created a real project (full plan flow, an AI
 * call), published a real Coolify preview, screenshotted it and soft-deleted the
 * project — sequentially, inside one server action. Ten seeded built-ins meant
 * ten AI plans plus ten deploys in one request: past any gateway timeout, so the
 * operator saw a failure while the work carried on and the results were lost.
 *
 * The bound is asserted here against the action itself, not just the pure
 * selector, because the selector existed while the action still ignored it.
 */

const auth = vi.hoisted(() => ({ requireAdmin: vi.fn(), getSessionUser: vi.fn() }));
const plans = vi.hoisted(() => ({ checkLimit: vi.fn() }));
const projects = vi.hoisted(() => ({ createProject: vi.fn(), deleteProject: vi.fn() }));
const store = vi.hoisted(() => ({ listTemplateRows: vi.fn(), updateTemplateRow: vi.fn() }));
const thumbs = vi.hoisted(() => ({ captureThumbnailFromUrl: vi.fn(), thumbnailUrlBase: vi.fn() }));
const publish = vi.hoisted(() => ({ publishProjectAndWait: vi.fn() }));
const jobs = vi.hoisted(() => ({ withRecordedJob: vi.fn() }));
const logger = vi.hoisted(() => ({
  log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
  logError: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  requireAdmin: auth.requireAdmin,
  getSessionUser: auth.getSessionUser,
}));
vi.mock('@/lib/db', () => ({ prisma: {} }));
vi.mock('@/lib/plans/limits', () => ({ checkLimit: plans.checkLimit }));
vi.mock('@/lib/plans/http', () => ({
  asCreditActionErr: (limit: { error?: string }) => ({
    ok: false as const,
    error: limit.error ?? 'Limit reached',
    status: 402,
  }),
}));
vi.mock('@/lib/projects/actions', () => ({
  createProject: projects.createProject,
  deleteProject: projects.deleteProject,
}));
vi.mock('@/lib/templates/store', () => ({
  listTemplateRows: store.listTemplateRows,
  updateTemplateRow: store.updateTemplateRow,
  deleteTemplateRow: vi.fn(),
  findTemplateById: vi.fn(),
  insertTemplate: vi.fn(),
  uniqueSlug: vi.fn(),
}));
vi.mock('@/lib/templates/thumbnails', () => ({
  captureThumbnailFromUrl: thumbs.captureThumbnailFromUrl,
  thumbnailUrlBase: thumbs.thumbnailUrlBase,
  storeThumbnailBuffer: vi.fn(),
}));
vi.mock('@/lib/publish/publish', () => ({
  publishProjectAndWait: publish.publishProjectAndWait,
}));
vi.mock('@/lib/jobs/wrap', () => ({ withRecordedJob: jobs.withRecordedJob }));
vi.mock('@/lib/audit/log', () => ({ writeAudit: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: logger.log, logError: logger.logError }));

function builtIn(slug: string) {
  return {
    id: `t-${slug}`,
    slug,
    name: slug,
    prompt: `Build ${slug}`,
    stack: 'NEXTJS',
    designDirection: 'clean',
    isBuiltIn: true,
    thumbnailKey: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  auth.requireAdmin.mockResolvedValue({ user: { id: 'admin-1', role: 'ADMIN' } });
  plans.checkLimit.mockResolvedValue({ ok: true });
  projects.createProject.mockImplementation(async () => ({
    ok: true,
    data: {
      id: `p-${projects.createProject.mock.calls.length}`,
      project: { previewUrl: 'https://preview.example.com/p' },
    },
  }));
  projects.deleteProject.mockResolvedValue({ ok: true });
  publish.publishProjectAndWait.mockResolvedValue({ url: 'https://live.example.com/p' });
  jobs.withRecordedJob.mockImplementation(
    async (_input: unknown, work: (id: string) => Promise<unknown>) => work('job-1'),
  );
  thumbs.captureThumbnailFromUrl.mockResolvedValue('thumbs/key.png');
  store.updateTemplateRow.mockResolvedValue({});
});

describe('adminGenerateThumbnails is bounded', () => {
  it('creates at most one real project per press, however many templates are pending', async () => {
    store.listTemplateRows.mockResolvedValue(['a', 'b', 'c', 'd', 'e'].map(builtIn));
    const { adminGenerateThumbnails } = await import('@/lib/templates/actions');

    const result = await adminGenerateThumbnails();

    expect(result.ok).toBe(true);
    // The bound is the point: five pending templates must not become five AI
    // plans and five Coolify deploys in one request.
    expect(projects.createProject).toHaveBeenCalledTimes(1);
    expect(publish.publishProjectAndWait).toHaveBeenCalledTimes(1);
    if (!result.ok) throw new Error('expected ok');
    expect(result.data.results).toHaveLength(1);
  });

  it('reports how many are left so the operator can see the work is unfinished', async () => {
    store.listTemplateRows.mockResolvedValue(['a', 'b', 'c'].map(builtIn));
    const { adminGenerateThumbnails } = await import('@/lib/templates/actions');

    const result = await adminGenerateThumbnails();

    if (!result.ok) throw new Error('expected ok');
    expect(result.data.remaining).toBe(2);
    expect(result.data.message).toMatch(/2 built-in templates still need a thumbnail/);
  });

  it('charges the plan limit for the project it is about to create, per press', async () => {
    store.listTemplateRows.mockResolvedValue(['a', 'b'].map(builtIn));
    plans.checkLimit.mockResolvedValue({ ok: false, error: 'Project limit reached' });
    const { adminGenerateThumbnails } = await import('@/lib/templates/actions');

    const result = await adminGenerateThumbnails();

    expect(result.ok).toBe(false);
    expect(projects.createProject).not.toHaveBeenCalled();
  });

  it('deletes the throwaway project even when recording the thumbnail throws', async () => {
    store.listTemplateRows.mockResolvedValue([builtIn('a')]);
    store.updateTemplateRow.mockRejectedValue(new Error('db is gone'));
    const { adminGenerateThumbnails } = await import('@/lib/templates/actions');

    const result = await adminGenerateThumbnails();

    // The leak F-823 describes: cleanup sat after the inner catch, so a throw
    // past it stranded a real "Thumbnail <name>" project until the purge cron.
    expect(projects.deleteProject).toHaveBeenCalledWith('p-1');
    if (!result.ok) throw new Error('expected ok');
    expect(result.data.results[0]?.ok).toBe(false);
  });

  it('records a leak when deleteProject refuses instead of throwing', async () => {
    store.listTemplateRows.mockResolvedValue([builtIn('a')]);
    // `deleteProject` reports expected failures by returning `ok: false`. A
    // `.catch` alone would not see it, and the stranded project would be
    // invisible.
    projects.deleteProject.mockResolvedValue({ ok: false, error: 'Forbidden', status: 403 });
    const { adminGenerateThumbnails } = await import('@/lib/templates/actions');

    const result = await adminGenerateThumbnails();

    expect(result.ok).toBe(true);
    expect(logger.logError).toHaveBeenCalledWith(
      'templates.thumbnail_cleanup_failed',
      expect.any(Error),
      expect.objectContaining({ projectId: 'p-1' }),
    );
  });

  it('says nothing is pending without creating a project', async () => {
    store.listTemplateRows.mockResolvedValue([{ ...builtIn('a'), thumbnailKey: 'thumbs/a.png' }]);
    const { adminGenerateThumbnails } = await import('@/lib/templates/actions');

    const result = await adminGenerateThumbnails();

    if (!result.ok) throw new Error('expected ok');
    expect(result.data.remaining).toBe(0);
    expect(projects.createProject).not.toHaveBeenCalled();
    expect(result.data.message).toMatch(/already has a thumbnail/);
  });
});
