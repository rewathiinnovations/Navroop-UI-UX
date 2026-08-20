/**
 * SQL for the project list fallback in `lib/projects/actions.ts`.
 *
 * Lives outside that `'use server'` file so it can be exported and tested without
 * creating a Server Action endpoint, and outside the caller so the rare path it serves —
 * only reached when the Prisma client is stale — is still covered by a real-database test
 * rather than by inspection.
 *
 * Filters are fixed text with placeholders numbered here; every caller-supplied value is
 * bound. Composed `Prisma.sql` fragments are deliberately not interpolated into a
 * `$queryRaw` tagged template — see the note on JOB_COLUMNS in lib/jobs/store.ts.
 */

export type ListProjectsQuery = {
  userId: string;
  sort: string;
  search?: string;
  mine?: boolean;
  starred: boolean;
  /**
   * F-314: same row cap as the Prisma path. Both order newest-first, so the two
   * paths return the same rows rather than one of them returning the whole table.
   */
  limit?: number;
};

export function buildProjectListQuery(query: ListProjectsQuery) {
  const values: unknown[] = [];
  const bind = (value: unknown) => {
    values.push(value);
    return `$${values.length}`;
  };

  const starredSelect = `EXISTS (
        SELECT 1 FROM "ProjectStar" s
        WHERE s."projectId" = p.id AND s."userId" = ${bind(query.userId)}
      ) AS starred`;

  const filters: string[] = ['p."deletedAt" IS NULL'];
  if (query.mine === true) filters.push(`p."ownerId" = ${bind(query.userId)}`);
  if (query.mine === false) filters.push(`p."ownerId" <> ${bind(query.userId)}`);
  if (query.search) {
    // One bind, used twice: same term against the name and the original prompt, matching the
    // Prisma path in `listProjects`.
    const term = bind(`%${query.search}%`);
    filters.push(`(p.name ILIKE ${term} OR p."initialPrompt" ILIKE ${term})`);
  }
  if (query.starred) {
    filters.push(
      `EXISTS (SELECT 1 FROM "ProjectStar" s WHERE s."projectId" = p.id AND s."userId" = ${bind(query.userId)})`,
    );
  }

  const orderBy =
    query.sort === 'name'
      ? 'p.name ASC'
      : query.sort === 'createdAt'
        ? 'p."createdAt" DESC'
        : 'p."updatedAt" DESC';

  const requested = query.limit ?? 0;
  const limit = Number.isFinite(requested) && requested > 0 ? Math.trunc(requested) : null;

  return {
    sql: `SELECT
      p.id,
      p.name,
      p."thumbnailUrl",
      p.status,
      p.phase,
      p."createdAt",
      p."updatedAt",
      p."ownerId",
      u.name AS "ownerName",
      u."avatarUrl" AS "ownerAvatarUrl",
      ${starredSelect}
    FROM "Project" p
    INNER JOIN "User" u ON u.id = p."ownerId"
    WHERE ${filters.join(' AND ')}
    ORDER BY ${orderBy}${limit === null ? '' : `\n    LIMIT ${bind(limit)}`}`,
    values,
  };
}
