import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * F-404: `/admin` loaded five sources with `.catch(() => [])` / `.catch(() => null)`
 * and then printed a success-toned "Nothing needs attention" banner on top of
 * swallowed database errors, with the stat tiles reading `—`, `0`, `0/4`. The
 * green all-clear is a claim the code did not verify.
 *
 * These tests call the server component with rejecting sources and walk the
 * returned element tree: a failed source must produce the warning banner and
 * suppress the success banner; the success banner may only render when every
 * source loaded and reported nothing.
 */

const prisma = vi.hoisted(() => ({
  user: { count: vi.fn() },
  workspace: { findUnique: vi.fn() },
}));
const stores = vi.hoisted(() => ({
  listIntegrations: vi.fn(),
  listActiveJobs: vi.fn(),
  describeSettings: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ prisma }));
vi.mock('@/lib/integrations/store', () => ({ listIntegrations: stores.listIntegrations }));
vi.mock('@/lib/jobs/store', () => ({ listActiveJobs: stores.listActiveJobs }));
vi.mock('@/lib/settings/resolve', () => ({ describeSettings: stores.describeSettings }));
vi.mock('@/lib/logger', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import AdminHomePage from '@/app/(app)/admin/page';
import StatusBanner from '@/components/admin/StatusBanner';

type AnyElement = { type: unknown; props: Record<string, unknown> };

function isElement(node: object): node is AnyElement {
  if (!('type' in node) || !('props' in node)) return false;
  return Boolean(node.type) && typeof node.props === 'object' && node.props !== null;
}

function collectElements(node: unknown, out: AnyElement[] = []): AnyElement[] {
  if (node == null || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const child of node) collectElements(child, out);
    return out;
  }
  if (isElement(node)) {
    out.push(node);
    collectElements(node.props.children, out);
  }
  return out;
}

function textOf(node: unknown): string {
  if (node == null) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (typeof node === 'object' && isElement(node)) return textOf(node.props.children);
  return '';
}

function banners(tree: unknown) {
  return collectElements(tree)
    .filter((el) => el.type === StatusBanner)
    .map((el) => ({ tone: String(el.props.tone), text: textOf(el.props.children) }));
}

const HEALTHY_SETTINGS = {
  settings: [
    { group: 'ai', key: 'deepseek.apiKey', configured: true },
    { key: 'github.oauth.clientId', configured: true },
    { key: 'github.oauth.clientSecret', configured: true },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  stores.describeSettings.mockResolvedValue(HEALTHY_SETTINGS);
  stores.listIntegrations.mockResolvedValue([]);
  stores.listActiveJobs.mockResolvedValue([]);
  prisma.user.count.mockResolvedValue(3);
  prisma.workspace.findUnique.mockResolvedValue({
    storageBytes: 0,
    storageLimitBytes: 100,
  });
});

describe('/admin home banners', () => {
  it('a dead database renders "could not check", never the green all-clear', async () => {
    const boom = new Error("Can't reach database server");
    stores.describeSettings.mockRejectedValue(boom);
    stores.listIntegrations.mockRejectedValue(boom);
    stores.listActiveJobs.mockRejectedValue(boom);
    prisma.user.count.mockRejectedValue(boom);
    prisma.workspace.findUnique.mockRejectedValue(boom);

    const tree = await AdminHomePage();
    const found = banners(tree);

    expect(found.some((b) => b.tone === 'success')).toBe(false);
    const warning = found.find((b) => b.tone === 'warning');
    expect(warning).toBeDefined();
    expect(warning!.text).toContain('Could not check');
    expect(warning!.text).toContain('settings');
    expect(warning!.text).toContain('integrations');
    expect(warning!.text).toContain('member count');
    expect(warning!.text).toContain('active jobs');
    expect(warning!.text).toContain('workspace storage');
  });

  it('one failed source suppresses the all-clear even when everything else is healthy', async () => {
    stores.listIntegrations.mockRejectedValue(new Error('502'));

    const tree = await AdminHomePage();
    const found = banners(tree);

    expect(found.some((b) => b.tone === 'success')).toBe(false);
    const warning = found.find((b) => b.tone === 'warning');
    expect(warning).toBeDefined();
    expect(warning!.text).toContain('integrations');
    expect(warning!.text).not.toContain('member count');
  });

  it('every source loaded and clean renders the all-clear and no warning', async () => {
    const tree = await AdminHomePage();
    const found = banners(tree);

    expect(found.some((b) => b.tone === 'warning')).toBe(false);
    const success = found.find((b) => b.tone === 'success');
    expect(success).toBeDefined();
    expect(success!.text).toContain('Nothing needs attention');
  });

  it('verified attention items still render as error banners alongside a partial failure', async () => {
    // AI key missing -> collectAttention (settings+integrations both loaded)
    // produces a real item; an unrelated source failing must not hide it.
    stores.describeSettings.mockResolvedValue({
      settings: [
        { group: 'ai', key: 'deepseek.apiKey', configured: false },
        { key: 'github.oauth.clientId', configured: true },
        { key: 'github.oauth.clientSecret', configured: true },
      ],
    });
    prisma.user.count.mockRejectedValue(new Error('timeout'));

    const tree = await AdminHomePage();
    const found = banners(tree);

    expect(found.some((b) => b.tone === 'success')).toBe(false);
    expect(found.some((b) => b.tone === 'warning' && b.text.includes('member count'))).toBe(true);
    expect(found.some((b) => b.tone === 'error')).toBe(true);
  });
});
