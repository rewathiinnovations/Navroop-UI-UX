import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BUILTIN_TEMPLATE_DELETE_FORBIDDEN,
  WORKSPACE_TEMPLATE_DELETE_FORBIDDEN,
  canDeleteTemplate,
  isBuiltInTemplate,
} from '@/lib/templates/auth';

/**
 * Member-facing template delete. Admin already has `adminDeleteTemplate` +
 * `DELETE /api/admin/templates/:id`; this is the missing surface for workspace
 * templates saved via “Save as template”, plus the built-in refuse copy.
 *
 * Soft-delete is not a thing — `Template` has no `deletedAt`. Hard delete of a
 * row this workspace owns is fine; another workspace’s row is 404, never leaked.
 */

const MEMBER = { id: 'member-1', email: 'member@navroop.invalid', role: 'MEMBER' as const };
const OTHER_MEMBER = { id: 'member-2', email: 'other@navroop.invalid', role: 'MEMBER' as const };
const ADMIN = { id: 'admin-1', email: 'admin@navroop.invalid', role: 'ADMIN' as const };

const WORKSPACE = {
  id: 't-ws',
  slug: 'bakery',
  name: 'Bakery',
  description: 'A bakery site',
  category: 'business',
  prompt: 'Build a bakery site',
  stack: 'NEXTJS',
  designDirection: 'warm',
  thumbnailKey: null,
  previewUrl: null,
  isBuiltIn: false,
  isActive: true,
  workspaceId: 'default',
  createdById: MEMBER.id,
  usageCount: 0,
  sortOrder: 0,
  createdAt: new Date('2026-08-01T00:00:00.000Z'),
};

const BUILTIN = {
  ...WORKSPACE,
  id: 't-builtin',
  slug: 'restaurant',
  name: 'Restaurant',
  isBuiltIn: true,
  workspaceId: null,
  createdById: null,
};

const OTHER_WORKSPACE = {
  ...WORKSPACE,
  id: 't-other',
  workspaceId: 'other-workspace',
  createdById: 'stranger',
};

describe('isBuiltInTemplate', () => {
  it('treats isBuiltIn or a null workspace as built-in', () => {
    expect(isBuiltInTemplate(BUILTIN)).toBe(true);
    expect(isBuiltInTemplate({ isBuiltIn: false, workspaceId: null })).toBe(true);
    expect(isBuiltInTemplate(WORKSPACE)).toBe(false);
  });
});

describe('canDeleteTemplate', () => {
  it('lets the workspace owner delete a workspace template', () => {
    expect(canDeleteTemplate(MEMBER, WORKSPACE)).toBe(true);
  });

  it('lets an ADMIN delete a workspace template they did not save', () => {
    expect(canDeleteTemplate(ADMIN, WORKSPACE)).toBe(true);
  });

  it('refuses a MEMBER who did not save the workspace template', () => {
    expect(canDeleteTemplate(OTHER_MEMBER, WORKSPACE)).toBe(false);
  });

  it('refuses a MEMBER on a built-in and lets an ADMIN through', () => {
    expect(canDeleteTemplate(MEMBER, BUILTIN)).toBe(false);
    expect(canDeleteTemplate(ADMIN, BUILTIN)).toBe(true);
  });

  it('refuses a row belonging to another workspace, even for ADMIN', () => {
    // Visibility, not a leak: the caller must not learn the row exists.
    expect(canDeleteTemplate(ADMIN, OTHER_WORKSPACE)).toBe(false);
    expect(canDeleteTemplate(MEMBER, OTHER_WORKSPACE)).toBe(false);
  });
});

const auth = vi.hoisted(() => ({ getSessionUser: vi.fn(), requireAdmin: vi.fn() }));
const store = vi.hoisted(() => ({
  findTemplateById: vi.fn(),
  deleteTemplateRow: vi.fn(),
}));
const audit = vi.hoisted(() => ({ writeAudit: vi.fn() }));

vi.mock('@/lib/auth', () => ({
  getSessionUser: auth.getSessionUser,
  requireAdmin: auth.requireAdmin,
}));
vi.mock('@/lib/templates/store', () => ({
  findTemplateById: store.findTemplateById,
  findTemplateBySlug: vi.fn(),
  listTemplateRows: vi.fn(),
  updateTemplateRow: vi.fn(),
  deleteTemplateRow: store.deleteTemplateRow,
  insertTemplate: vi.fn(),
  uniqueSlug: (name: string) => `${name}-generated`,
}));
vi.mock('@/lib/templates/create', () => ({ createProjectFromTemplate: vi.fn() }));
vi.mock('@/lib/templates/thumbnails', () => ({
  captureThumbnailFromUrl: vi.fn(),
  thumbnailUrlBase: vi.fn(async () => ''),
  thumbnailPublicUrl: (key: string | null) => (key ? `/thumbs/${key}` : null),
  storeThumbnailBuffer: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ prisma: { project: { findFirst: vi.fn() } } }));
vi.mock('@/lib/plans/limits', () => ({ checkLimit: vi.fn() }));
vi.mock('@/lib/publish/publish', () => ({ publishProjectAndWait: vi.fn() }));
vi.mock('@/lib/jobs/wrap', () => ({ withRecordedJob: vi.fn() }));
vi.mock('@/lib/audit/log', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/audit/log')>()),
  writeAudit: audit.writeAudit,
}));

describe('deleteTemplate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.getSessionUser.mockResolvedValue(MEMBER);
    store.findTemplateById.mockResolvedValue(WORKSPACE);
    store.deleteTemplateRow.mockResolvedValue(undefined);
  });

  it('rejects a signed-out caller with 401 and does not touch the row', async () => {
    auth.getSessionUser.mockResolvedValue(null);
    const { deleteTemplate } = await import('@/lib/templates/actions');

    const result = await deleteTemplate('t-ws');

    expect(result).toMatchObject({ ok: false, status: 401 });
    expect(store.findTemplateById).not.toHaveBeenCalled();
    expect(store.deleteTemplateRow).not.toHaveBeenCalled();
  });

  it('hard-deletes a workspace template the caller saved and writes an audit row', async () => {
    const { deleteTemplate } = await import('@/lib/templates/actions');

    const result = await deleteTemplate('t-ws');

    expect(result).toEqual({ ok: true, data: { id: 't-ws' } });
    expect(store.deleteTemplateRow).toHaveBeenCalledWith('t-ws');
    expect(audit.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: MEMBER.id,
        action: 'template.delete',
        targetType: 'template',
        targetId: 't-ws',
        after: { name: WORKSPACE.name },
      }),
    );
  });

  it('lets an ADMIN delete a workspace template they did not save', async () => {
    auth.getSessionUser.mockResolvedValue(ADMIN);
    const { deleteTemplate } = await import('@/lib/templates/actions');

    expect((await deleteTemplate('t-ws')).ok).toBe(true);
    expect(store.deleteTemplateRow).toHaveBeenCalledWith('t-ws');
  });

  it('refuses a MEMBER who did not save the template, in English', async () => {
    auth.getSessionUser.mockResolvedValue(OTHER_MEMBER);
    const { deleteTemplate } = await import('@/lib/templates/actions');

    const result = await deleteTemplate('t-ws');

    expect(result).toMatchObject({
      ok: false,
      status: 403,
      error: WORKSPACE_TEMPLATE_DELETE_FORBIDDEN,
    });
    expect(store.deleteTemplateRow).not.toHaveBeenCalled();
    expect(audit.writeAudit).not.toHaveBeenCalled();
  });

  it('refuses a MEMBER deleting a built-in, in English', async () => {
    store.findTemplateById.mockResolvedValue(BUILTIN);
    const { deleteTemplate } = await import('@/lib/templates/actions');

    const result = await deleteTemplate('t-builtin');

    expect(result).toMatchObject({
      ok: false,
      status: 403,
      error: BUILTIN_TEMPLATE_DELETE_FORBIDDEN,
    });
    expect(store.deleteTemplateRow).not.toHaveBeenCalled();
  });

  it('lets an ADMIN delete a built-in', async () => {
    auth.getSessionUser.mockResolvedValue(ADMIN);
    store.findTemplateById.mockResolvedValue(BUILTIN);
    const { deleteTemplate } = await import('@/lib/templates/actions');

    expect((await deleteTemplate('t-builtin')).ok).toBe(true);
    expect(store.deleteTemplateRow).toHaveBeenCalledWith('t-builtin');
  });

  it('answers 404 for another workspace and does not delete', async () => {
    store.findTemplateById.mockResolvedValue(OTHER_WORKSPACE);
    auth.getSessionUser.mockResolvedValue(ADMIN);
    const { deleteTemplate } = await import('@/lib/templates/actions');

    const result = await deleteTemplate('t-other');

    expect(result).toMatchObject({ ok: false, status: 404, error: 'Template not found' });
    expect(store.deleteTemplateRow).not.toHaveBeenCalled();
    expect(audit.writeAudit).not.toHaveBeenCalled();
  });

  it('answers 404 when the row is missing', async () => {
    store.findTemplateById.mockResolvedValue(null);
    const { deleteTemplate } = await import('@/lib/templates/actions');

    expect(await deleteTemplate('missing')).toMatchObject({ ok: false, status: 404 });
    expect(store.deleteTemplateRow).not.toHaveBeenCalled();
  });
});
