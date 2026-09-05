import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildProjectListQuery } from '@/lib/projects/list-sql';
import { buildProjectsApiUrl } from '@/lib/projects/list-client';

/**
 * Searching on `/projects` used to be a second, poorer code path.
 *
 * The page called `/api/search` the moment the box had text. That payload carries id, name,
 * status, phase and updatedAt — nothing else — so the page built `ListProject` rows by hand
 * with `thumbnailUrl: null` and `ownerId: ''`: every result lost its screenshot and read as
 * owned by "Member". `searchProjects` also takes neither `mine` nor `starred`, so choosing
 * "Owned by me" or "Starred" and then typing silently widened the results to the whole
 * workspace. The same project looked different depending on how you found it.
 *
 * `listProjects` already filtered by search, so the fix was to delete the second path. These
 * cases pin what that buys: the filters travel with the search, and the rows are the same
 * rows.
 *
 * Modules under test are pulled in with `await import` inside each case, as the sibling unit
 * tests do: a static import would bind before `vi.mock` registers.
 */

const db = vi.hoisted(() => ({ projectFindMany: vi.fn() }));
const auth = vi.hoisted(() => ({ getSessionUser: vi.fn() }));

vi.mock('@/lib/db', () => ({
  prisma: { project: { findMany: db.projectFindMany } },
}));

/** next-auth cannot resolve `next/server` outside the Next runtime. */
vi.mock('@/lib/auth', () => ({ getSessionUser: auth.getSessionUser }));

vi.mock('@/lib/projects/plan', () => ({
  peekActor: () => undefined,
  applyCreateProjectPlanFlow: async () => undefined,
}));
vi.mock('@/lib/checkpoints/actions', () => ({
  createCheckpointAfterGeneration: vi.fn(async () => null),
}));
vi.mock('@/lib/memory/extract', () => ({ extractMemoriesAfterGeneration: async () => undefined }));
vi.mock('@/lib/signals/collect', () => ({
  maybeSettleFollowups: async () => undefined,
  recordGenerationKept: async () => undefined,
}));

const USER = { id: 'u-1', email: 'owner@example.com', name: 'Owner', role: 'MEMBER' as const };

beforeEach(() => {
  vi.clearAllMocks();
  auth.getSessionUser.mockResolvedValue(USER);
  db.projectFindMany.mockResolvedValue([]);
});

type ListQuery = { search?: string; sort?: string; mine?: boolean; starred?: boolean };

/** The query `listProjects` put to the database. */
async function listWith(query: ListQuery) {
  const { listProjects } = await import('@/lib/projects/actions');
  await listProjects(query);
  return db.projectFindMany.mock.calls[0]?.[0] as {
    where: Record<string, unknown>;
    select: Record<string, unknown>;
  };
}

describe('a search on /projects', () => {
  it('keeps the owned-by-me and starred filters applied', async () => {
    const { where } = await listWith({ search: 'bakery', mine: true, starred: true });

    expect(where.ownerId).toBe(USER.id);
    expect(where.stars).toEqual({ some: { userId: USER.id } });
    expect(where.deletedAt).toBeNull();
  });

  it('matches the name and the original prompt', async () => {
    const { where } = await listWith({ search: 'bakery' });

    expect(where.OR).toEqual([
      { name: { contains: 'bakery', mode: 'insensitive' } },
      { initialPrompt: { contains: 'bakery', mode: 'insensitive' } },
    ]);
  });

  it('returns the fields a project card draws, not a hand-built subset', async () => {
    const { select } = await listWith({ search: 'bakery' });

    // These four are exactly what the search branch could not supply.
    expect(select.thumbnailUrl).toBe(true);
    expect(select.ownerId).toBe(true);
    expect(select.owner).toBeTruthy();
    expect(select.stars).toBeTruthy();
  });

  it('does not filter at all when the box is empty', async () => {
    const { where } = await listWith({ search: '   ' });

    expect(where.OR).toBeUndefined();
  });

  it('asks the projects API for the search, the sort and the filters together', () => {
    const url = buildProjectsApiUrl({
      search: ' bakery ',
      sort: 'name',
      mine: true,
      starred: true,
    });

    expect(url).toBe('/api/projects?search=bakery&sort=name&mine=true&starred=true');
  });

  it('filters name and prompt in the stale-client SQL fallback too', () => {
    const { sql, values } = buildProjectListQuery({
      userId: USER.id,
      sort: 'updatedAt',
      search: 'bakery',
      mine: true,
      starred: true,
    });

    expect(sql).toContain('p.name ILIKE');
    expect(sql).toContain('p."initialPrompt" ILIKE');
    // One bind for both sides, and every value still bound rather than interpolated.
    expect(values.filter((value) => value === '%bakery%')).toHaveLength(1);
    expect(sql).not.toMatch(/\$\{/);
    expect(sql).toContain('p."ownerId" =');
    expect(sql).toContain('"ProjectStar"');
  });
});

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

describe('the /projects page', () => {
  it('has no second search path left', () => {
    const page = readFileSync(path.join(repoRoot, 'app/(app)/projects/page.tsx'), 'utf8');

    // The call, not the word: the comment above `load` names the endpoint it no longer uses.
    expect(page).not.toMatch(/fetch\(`?\/api\/search/);
    // The tell-tale of a hand-built row: a card with no owner and no screenshot.
    expect(page).not.toContain("ownerId: ''");
    expect(page).toContain('fetchProjectList');
  });
});
