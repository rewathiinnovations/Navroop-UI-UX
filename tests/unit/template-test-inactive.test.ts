import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * F-824: `adminTestTemplate` delegated to `createFromTemplate`, whose gate ran
 * without `{ includeInactive: true }`, so `visibility.ts` rejected any row with
 * `isActive === false`. `adminListTemplates` passes `includeInactive: true`, so
 * the admin table listed inactive templates and offered Test on them — and
 * answered "Template not found" for a row the same screen was displaying.
 * Test-before-activate is the natural workflow and it was the one that failed.
 *
 * `isVisibleToWorkspace` already had unit coverage for the option itself
 * (`tests/templates.test.ts`). What was untested, and what actually broke, is
 * whether the admin action passes it.
 */

const auth = vi.hoisted(() => ({ requireAdmin: vi.fn(), getSessionUser: vi.fn() }));
const store = vi.hoisted(() => ({ findTemplateById: vi.fn() }));
const create = vi.hoisted(() => ({ createProjectFromTemplate: vi.fn() }));

vi.mock('@/lib/auth', () => ({
  requireAdmin: auth.requireAdmin,
  getSessionUser: auth.getSessionUser,
}));
vi.mock('@/lib/db', () => ({ prisma: {} }));
vi.mock('@/lib/templates/store', () => ({
  findTemplateById: store.findTemplateById,
  listTemplateRows: vi.fn(),
  updateTemplateRow: vi.fn(),
  deleteTemplateRow: vi.fn(),
  insertTemplate: vi.fn(),
  uniqueSlug: vi.fn(),
}));
vi.mock('@/lib/templates/create', () => ({
  createProjectFromTemplate: create.createProjectFromTemplate,
}));
vi.mock('@/lib/templates/thumbnails', () => ({
  captureThumbnailFromUrl: vi.fn(),
  thumbnailUrlBase: vi.fn(),
  storeThumbnailBuffer: vi.fn(),
}));
vi.mock('@/lib/plans/limits', () => ({ checkLimit: vi.fn() }));
vi.mock('@/lib/publish/publish', () => ({ publishProjectAndWait: vi.fn() }));
vi.mock('@/lib/jobs/wrap', () => ({ withRecordedJob: vi.fn() }));
vi.mock('@/lib/audit/log', () => ({ writeAudit: vi.fn() }));

const INACTIVE_BUILT_IN = {
  id: 't-1',
  slug: 'saas-landing',
  name: 'SaaS landing',
  prompt: 'Build a SaaS landing page',
  stack: 'NEXTJS',
  designDirection: 'clean',
  isBuiltIn: true,
  isActive: false,
  workspaceId: null,
  thumbnailKey: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  auth.requireAdmin.mockResolvedValue({ user: { id: 'admin-1', role: 'ADMIN' } });
  auth.getSessionUser.mockResolvedValue({ id: 'admin-1', role: 'ADMIN' });
  create.createProjectFromTemplate.mockResolvedValue({
    ok: true,
    data: { id: 'p-1', project: { id: 'p-1' } },
  });
});

describe('adminTestTemplate reaches an inactive template', () => {
  it('tests a deactivated built-in instead of answering "Template not found"', async () => {
    store.findTemplateById.mockResolvedValue(INACTIVE_BUILT_IN);
    const { adminTestTemplate } = await import('@/lib/templates/actions');

    const result = await adminTestTemplate('t-1');

    expect(result.ok).toBe(true);
    expect(create.createProjectFromTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ templateId: 't-1', prompt: INACTIVE_BUILT_IN.prompt }),
    );
  });

  it('still 404s a template that does not exist at all', async () => {
    store.findTemplateById.mockResolvedValue(null);
    const { adminTestTemplate } = await import('@/lib/templates/actions');

    const result = await adminTestTemplate('gone');

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected notFound');
    expect(result.status).toBe(404);
    expect(create.createProjectFromTemplate).not.toHaveBeenCalled();
  });

  it('does not let inactive-visibility leak to the member-facing entry point', async () => {
    store.findTemplateById.mockResolvedValue(INACTIVE_BUILT_IN);
    const { createFromTemplate } = await import('@/lib/templates/actions');

    // The widened gate is for the admin Test button only. A member creating from
    // a deactivated template must still be refused.
    const result = await createFromTemplate('t-1', {});

    expect(result.ok).toBe(false);
    expect(create.createProjectFromTemplate).not.toHaveBeenCalled();
  });

  it('refuses a non-admin', async () => {
    auth.requireAdmin.mockResolvedValue({ user: null, error: 'Forbidden', status: 403 });
    store.findTemplateById.mockResolvedValue(INACTIVE_BUILT_IN);
    const { adminTestTemplate } = await import('@/lib/templates/actions');

    const result = await adminTestTemplate('t-1');

    expect(result.ok).toBe(false);
    expect(create.createProjectFromTemplate).not.toHaveBeenCalled();
  });
});
