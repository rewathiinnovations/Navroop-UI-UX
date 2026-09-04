import { beforeEach, describe, expect, it, vi } from 'vitest';
import { issuePreviewToken } from '@/lib/preview/token';
import { PUBLIC_PREVIEW_VIEW_PATH } from '@/lib/preview/public-view';

const db = vi.hoisted(() => ({
  getProjectPreviewFields: vi.fn(),
  findUnique: vi.fn(),
  findFirst: vi.fn(),
  projectFindFirst: vi.fn(),
}));

const served = vi.hoisted(() => ({ servedProjectFiles: vi.fn() }));
const integrations = vi.hoisted(() => ({ peekRootDomain: vi.fn() }));
const settings = vi.hoisted(() => ({ getSetting: vi.fn() }));

vi.mock('@/lib/preview/db', () => ({
  getProjectPreviewFields: db.getProjectPreviewFields,
  previewBuildTable: () => ({
    findUnique: db.findUnique,
    findFirst: db.findFirst,
  }),
}));

vi.mock('@/lib/db', () => ({
  prisma: {
    project: { findFirst: db.projectFindFirst },
  },
}));

vi.mock('@/lib/checkpoints/served-files', () => ({
  servedProjectFiles: served.servedProjectFiles,
}));

vi.mock('@/lib/integrations/store', () => ({ peekRootDomain: integrations.peekRootDomain }));
vi.mock('@/lib/settings/resolve', () => ({ getSetting: settings.getSetting }));

const PROJECT = 'proj-1';
const USER = 'user-1';
const LAST_CODE = '<file path="index.html">hello</file>';

beforeEach(() => {
  vi.clearAllMocks();
  process.env.AUTH_SECRET = 'preview-test-secret';
  process.env.APP_URL = 'https://navroop.example';
  integrations.peekRootDomain.mockResolvedValue('navroop.app');
  settings.getSetting.mockResolvedValue(null);
  db.findUnique.mockResolvedValue(null);
  db.findFirst.mockResolvedValue(null);
});

describe('getPreviewStatus new-tab URL', () => {
  it('mints /preview-view?projectId=&token= when the project has files, even with a Cloudflare zone', async () => {
    db.getProjectPreviewFields.mockResolvedValue({
      previewMode: 'STATIC',
      activePreviewBuildId: null,
      stack: 'NEXTJS',
      previewUrl: null,
      lastCode: LAST_CODE,
    });

    const { getPreviewStatus } = await import('@/lib/preview/status');
    const status = await getPreviewStatus(PROJECT, { userId: USER, mayMint: true });

    expect(status).not.toBeNull();
    expect(status?.previewUrl).toMatch(
      new RegExp(`^${PUBLIC_PREVIEW_VIEW_PATH}\\?projectId=${PROJECT}&token=`),
    );
    expect(status?.previewUrl).not.toContain('preview-static');
    expect(status?.previewUrl).not.toContain('navroop.app');
    expect(status?.previewUrl).not.toContain('u=');
  });

  it('returns no new-tab URL when the project has no site yet', async () => {
    db.getProjectPreviewFields.mockResolvedValue({
      previewMode: 'STATIC',
      activePreviewBuildId: null,
      stack: 'NEXTJS',
      previewUrl: null,
      lastCode: null,
    });

    const { getPreviewStatus } = await import('@/lib/preview/status');
    const status = await getPreviewStatus(PROJECT, { userId: USER, mayMint: true });

    expect(status?.previewUrl).toBeNull();
  });

  it('mints from lastCode even when the active preview build is not READY', async () => {
    db.getProjectPreviewFields.mockResolvedValue({
      previewMode: 'STATIC',
      activePreviewBuildId: 'build-failed',
      stack: 'NEXTJS',
      previewUrl: null,
      lastCode: LAST_CODE,
    });
    db.findUnique.mockResolvedValue({ id: 'build-failed', status: 'FAILED' });

    const { getPreviewStatus } = await import('@/lib/preview/status');
    const status = await getPreviewStatus(PROJECT, { userId: USER, mayMint: true });

    expect(status?.previewUrl).toMatch(
      new RegExp(`^${PUBLIC_PREVIEW_VIEW_PATH}\\?projectId=${PROJECT}&token=`),
    );
  });

  it('does not mint for a member who may not share the site anonymously', async () => {
    db.getProjectPreviewFields.mockResolvedValue({
      previewMode: 'STATIC',
      activePreviewBuildId: null,
      stack: 'NEXTJS',
      previewUrl: null,
      lastCode: LAST_CODE,
    });

    const { getPreviewStatus } = await import('@/lib/preview/status');
    const status = await getPreviewStatus(PROJECT, { userId: USER, mayMint: false });

    expect(status?.previewUrl).toBeNull();
  });
});

describe('loadPublicPreviewSite', () => {
  it('returns files for a valid token and refuses a missing or mismatched one', async () => {
    const token = issuePreviewToken({ projectId: PROJECT, userId: USER });
    db.projectFindFirst.mockResolvedValue({
      id: PROJECT,
      stack: 'NEXTJS',
      lastCode: LAST_CODE,
      designDirection: 'minimal',
    });
    served.servedProjectFiles.mockResolvedValue({
      ok: true,
      files: { 'index.html': 'hello' },
      previewing: null,
    });

    const { loadPublicPreviewSite } = await import('@/lib/preview/public-site');

    const ok = await loadPublicPreviewSite({ projectId: PROJECT, token });
    expect(ok).toMatchObject({
      ok: true,
      stack: 'NEXTJS',
      designDirection: 'minimal',
      files: { 'index.html': 'hello' },
    });

    const missing = await loadPublicPreviewSite({ projectId: PROJECT, token: null });
    expect(missing).toBeNull();

    const other = await loadPublicPreviewSite({ projectId: 'other', token });
    expect(other).toBeNull();
  });
});
