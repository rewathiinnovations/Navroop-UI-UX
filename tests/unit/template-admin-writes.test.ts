import { beforeEach, describe, expect, it, vi } from 'vitest';
import { REQUIRED_AUDIT_ACTIONS } from '@/lib/audit/log';

/**
 * Four defects in the three admin template *write* paths, all of them things the
 * read paths already got right.
 *
 * F-825: `adminCreateTemplate` and `adminDeleteTemplate` wrote an audit row;
 * `adminUpdateTemplate` and `adminUploadThumbnail` wrote nothing. Update is the
 * mutation with the widest blast radius — rewriting a built-in's prompt changes
 * every project generated from it afterwards — so `/admin/audit` could not
 * answer "who changed this template's prompt".
 *
 * F-826: all three writes resolved the row with `findTemplateById`, whose SQL is
 * `WHERE id = $1` with no workspace predicate, then mutated it without calling
 * `isVisibleToWorkspace`. Every read path checks. No second workspace exists
 * today, so this pins the invariant before one does.
 *
 * F-827: `Template.slug` is `@unique` and both writes are raw SQL with no
 * conflict handling, so an admin typing a slug that exists got a raw Postgres
 * unique violation thrown out of the server action instead of the typed result
 * every other validation failure in the module returns.
 *
 * F-828: "Save as template" read `plans: { orderBy: { version: 'desc' }, take: 1 }`
 * with no `status` filter, so it would seed a template from a PENDING or
 * SUPERSEDED plan — one the user had refined away or never accepted.
 */

const auth = vi.hoisted(() => ({ requireAdmin: vi.fn(), getSessionUser: vi.fn() }));
const store = vi.hoisted(() => ({
  findTemplateById: vi.fn(),
  findTemplateBySlug: vi.fn(),
  updateTemplateRow: vi.fn(),
  deleteTemplateRow: vi.fn(),
  insertTemplate: vi.fn(),
}));
const thumbs = vi.hoisted(() => ({ storeThumbnailBuffer: vi.fn(), thumbnailUrlBase: vi.fn() }));
const audit = vi.hoisted(() => ({ writeAudit: vi.fn() }));
const db = vi.hoisted(() => ({ projectFindFirst: vi.fn() }));

vi.mock('@/lib/auth', () => ({
  requireAdmin: auth.requireAdmin,
  getSessionUser: auth.getSessionUser,
}));
vi.mock('@/lib/db', () => ({ prisma: { project: { findFirst: db.projectFindFirst } } }));
vi.mock('@/lib/templates/store', () => ({
  findTemplateById: store.findTemplateById,
  findTemplateBySlug: store.findTemplateBySlug,
  listTemplateRows: vi.fn(),
  updateTemplateRow: store.updateTemplateRow,
  deleteTemplateRow: store.deleteTemplateRow,
  insertTemplate: store.insertTemplate,
  uniqueSlug: (name: string) => `${name}-generated`,
}));
vi.mock('@/lib/templates/create', () => ({ createProjectFromTemplate: vi.fn() }));
vi.mock('@/lib/templates/thumbnails', () => ({
  captureThumbnailFromUrl: vi.fn(),
  thumbnailUrlBase: thumbs.thumbnailUrlBase,
  thumbnailPublicUrl: (key: string | null) => (key ? `/thumbs/${key}` : null),
  storeThumbnailBuffer: thumbs.storeThumbnailBuffer,
}));
vi.mock('@/lib/plans/limits', () => ({ checkLimit: vi.fn() }));
vi.mock('@/lib/publish/publish', () => ({ publishProjectAndWait: vi.fn() }));
vi.mock('@/lib/jobs/wrap', () => ({ withRecordedJob: vi.fn() }));
vi.mock('@/lib/audit/log', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/audit/log')>()),
  writeAudit: audit.writeAudit,
}));

const OWN_WORKSPACE = 'default';

const ROW = {
  id: 't-1',
  slug: 'saas-landing',
  name: 'SaaS landing',
  description: 'A landing page',
  category: 'saas',
  prompt: 'Build a SaaS landing page',
  stack: 'NEXTJS',
  designDirection: 'clean',
  thumbnailKey: null,
  previewUrl: null,
  isBuiltIn: true,
  isActive: true,
  workspaceId: null,
  createdById: null,
  usageCount: 0,
  sortOrder: 0,
  createdAt: new Date('2026-08-01T00:00:00.000Z'),
};

beforeEach(() => {
  vi.clearAllMocks();
  auth.requireAdmin.mockResolvedValue({
    user: { id: 'admin-1', email: 'admin@example.com', role: 'ADMIN' },
  });
  auth.getSessionUser.mockResolvedValue({
    id: 'admin-1',
    email: 'admin@example.com',
    role: 'ADMIN',
  });
  store.findTemplateById.mockResolvedValue(ROW);
  store.findTemplateBySlug.mockResolvedValue(null);
  store.updateTemplateRow.mockImplementation(
    async (_id: string, patch: Record<string, unknown>) => {
      const next: Record<string, unknown> = { ...ROW };
      for (const [key, value] of Object.entries(patch)) {
        if (value !== undefined) next[key] = value;
      }
      return next;
    },
  );
  store.insertTemplate.mockResolvedValue({ ...ROW, id: 't-new' });
  thumbs.thumbnailUrlBase.mockResolvedValue('');
  thumbs.storeThumbnailBuffer.mockResolvedValue('thumbs/t-1.png');
});

describe('the audit action list covers template writes (F-825)', () => {
  it('names update and thumbnail alongside create and delete', () => {
    expect(REQUIRED_AUDIT_ACTIONS).toContain('template.update');
    expect(REQUIRED_AUDIT_ACTIONS).toContain('template.thumbnail');
  });
});

describe('adminUpdateTemplate', () => {
  it('writes an audit row carrying before/after on the fields that moved (F-825)', async () => {
    const { adminUpdateTemplate } = await import('@/lib/templates/actions');

    const result = await adminUpdateTemplate('t-1', {
      prompt: 'Rewritten prompt for the landing page',
    });

    expect(result.ok).toBe(true);
    expect(audit.writeAudit).toHaveBeenCalledTimes(1);
    const row = audit.writeAudit.mock.calls[0][0];
    expect(row.action).toBe('template.update');
    expect(row.targetId).toBe('t-1');
    expect(row.actorId).toBe('admin-1');
    expect(row.before).toMatchObject({ prompt: 'Build a SaaS landing page' });
    expect(row.after).toMatchObject({ prompt: 'Rewritten prompt for the landing page' });
  });

  it('does not report an unchanged field as a change', async () => {
    const { adminUpdateTemplate } = await import('@/lib/templates/actions');

    await adminUpdateTemplate('t-1', { prompt: ROW.prompt, isActive: false });

    const row = audit.writeAudit.mock.calls[0][0];
    expect(row.after).toMatchObject({ isActive: false });
    expect(row.after).not.toHaveProperty('prompt');
  });

  it('returns a 409 naming the slug rather than throwing a unique violation (F-827)', async () => {
    store.findTemplateBySlug.mockResolvedValue({ ...ROW, id: 't-other', slug: 'taken' });
    const { adminUpdateTemplate } = await import('@/lib/templates/actions');

    const result = await adminUpdateTemplate('t-1', { slug: 'taken' });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a conflict');
    expect(result.status).toBe(409);
    expect(result.error).toMatch(/slug/i);
    expect(result.details).toEqual({ field: 'slug' });
    expect(store.updateTemplateRow).not.toHaveBeenCalled();
  });

  it('lets a template keep its own slug', async () => {
    store.findTemplateBySlug.mockResolvedValue(ROW);
    const { adminUpdateTemplate } = await import('@/lib/templates/actions');

    const result = await adminUpdateTemplate('t-1', { slug: ROW.slug, name: 'Renamed' });

    expect(result.ok).toBe(true);
    expect(store.updateTemplateRow).toHaveBeenCalled();
  });

  it('refuses a row belonging to another workspace (F-826)', async () => {
    store.findTemplateById.mockResolvedValue({ ...ROW, workspaceId: 'other-workspace' });
    const { adminUpdateTemplate } = await import('@/lib/templates/actions');

    const result = await adminUpdateTemplate('t-1', {
      prompt: 'Rewritten prompt for the landing page',
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected notFound');
    expect(result.status).toBe(404);
    expect(store.updateTemplateRow).not.toHaveBeenCalled();
    expect(audit.writeAudit).not.toHaveBeenCalled();
  });

  it('still reaches an inactive row in its own workspace', async () => {
    store.findTemplateById.mockResolvedValue({
      ...ROW,
      isActive: false,
      workspaceId: OWN_WORKSPACE,
    });
    const { adminUpdateTemplate } = await import('@/lib/templates/actions');

    expect((await adminUpdateTemplate('t-1', { isActive: true })).ok).toBe(true);
  });
});

describe('adminCreateTemplate', () => {
  it('returns a 409 for an admin-supplied slug that exists (F-827)', async () => {
    store.findTemplateBySlug.mockResolvedValue({ ...ROW, id: 't-other' });
    const { adminCreateTemplate } = await import('@/lib/templates/actions');

    const result = await adminCreateTemplate({
      name: 'New template',
      description: 'x',
      category: 'saas',
      prompt: 'Build something substantial for a customer',
      slug: 'saas-landing',
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a conflict');
    expect(result.status).toBe(409);
    expect(store.insertTemplate).not.toHaveBeenCalled();
  });

  it('still generates a slug when the admin supplies none', async () => {
    const { adminCreateTemplate } = await import('@/lib/templates/actions');

    const result = await adminCreateTemplate({
      name: 'New template',
      description: 'x',
      category: 'saas',
      prompt: 'Build something substantial for a customer',
    });

    expect(result.ok).toBe(true);
    // No availability lookup is needed for the generated form: it carries 3 random bytes.
    expect(store.findTemplateBySlug).not.toHaveBeenCalled();
    expect(store.insertTemplate).toHaveBeenCalled();
  });
});

describe('adminDeleteTemplate and adminUploadThumbnail', () => {
  it('both refuse a row belonging to another workspace (F-826)', async () => {
    store.findTemplateById.mockResolvedValue({ ...ROW, workspaceId: 'other-workspace' });
    const { adminDeleteTemplate, adminUploadThumbnail } = await import('@/lib/templates/actions');

    expect((await adminDeleteTemplate('t-1')).ok).toBe(false);
    expect((await adminUploadThumbnail('t-1', Buffer.from('x'))).ok).toBe(false);
    expect(store.deleteTemplateRow).not.toHaveBeenCalled();
    expect(thumbs.storeThumbnailBuffer).not.toHaveBeenCalled();
  });

  it('the thumbnail upload leaves an audit trail (F-825)', async () => {
    const { adminUploadThumbnail } = await import('@/lib/templates/actions');

    const result = await adminUploadThumbnail('t-1', Buffer.from('png'));

    expect(result.ok).toBe(true);
    const row = audit.writeAudit.mock.calls[0][0];
    expect(row.action).toBe('template.thumbnail');
    expect(row.before).toMatchObject({ thumbnailKey: null });
    expect(row.after).toMatchObject({ thumbnailKey: 'thumbs/t-1.png' });
  });
});

describe('previewSaveAsTemplate reads only an approved plan (F-828)', () => {
  it('filters by APPROVED and orders deterministically', async () => {
    db.projectFindFirst.mockResolvedValue({
      id: 'p-1',
      name: 'My site',
      initialPrompt: 'A bakery site',
      stack: 'NEXTJS',
      designDirection: 'clean',
      ownerId: 'admin-1',
      previewUrl: null,
      plans: [{ content: { summary: 'Approved summary' } }],
    });
    const { previewSaveAsTemplate } = await import('@/lib/templates/actions');

    const result = await previewSaveAsTemplate('p-1');

    expect(result.ok).toBe(true);
    const select = db.projectFindFirst.mock.calls[0][0].select;
    expect(select.plans.where).toEqual({ status: 'APPROVED' });
    expect(select.plans.orderBy).toEqual([{ version: 'desc' }, { createdAt: 'desc' }]);
    expect(select.plans.take).toBe(1);
  });
});
