import { prisma } from '@/lib/db';

export type ProjectSearchHit = {
  id: string;
  name: string;
  snippet: string;
  status: string;
  phase: string | null;
  updatedAt: Date;
};

const HEADLINE =
  'StartSel=<mark>,StopSel=</mark>,MaxWords=18,MinWords=6,MaxFragments=1';

function snippetFrom(name: string, prompt: string, q: string) {
  const haystack = `${name} ${prompt}`;
  const index = haystack.toLowerCase().indexOf(q.toLowerCase());
  if (index < 0) return prompt.slice(0, 140) || name;
  const start = Math.max(0, index - 40);
  const end = Math.min(haystack.length, index + q.length + 80);
  return `${start > 0 ? '…' : ''}${haystack.slice(start, end).trim()}${end < haystack.length ? '…' : ''}`;
}

export async function searchProjects(input: { q: string; limit?: number }): Promise<ProjectSearchHit[]> {
  const q = input.q.trim();
  if (!q) return [];
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 20);

  try {
    const rows = await prisma.$queryRaw<ProjectSearchHit[]>`
      SELECT
        p.id,
        p.name,
        ts_headline(
          'english',
          coalesce(p.name, '') || ' ' || coalesce(p."initialPrompt", ''),
          websearch_to_tsquery('english', ${q}),
          ${HEADLINE}
        ) AS snippet,
        p.status,
        p.phase,
        p."updatedAt"
      FROM "Project" p
      WHERE p."deletedAt" IS NULL
        AND p."searchVector" @@ websearch_to_tsquery('english', ${q})
      ORDER BY ts_rank(p."searchVector", websearch_to_tsquery('english', ${q})) DESC, p."updatedAt" DESC
      LIMIT ${limit}
    `;
    return rows;
  } catch {
    const pattern = `%${q}%`;
    const rows = await prisma.$queryRaw<Array<ProjectSearchHit & { initialPrompt: string }>>`
      SELECT
        p.id,
        p.name,
        p."initialPrompt" AS "initialPrompt",
        p.status,
        p.phase,
        p."updatedAt"
      FROM "Project" p
      WHERE p."deletedAt" IS NULL
        AND (
          p.name ILIKE ${pattern}
          OR p."initialPrompt" ILIKE ${pattern}
        )
      ORDER BY p."updatedAt" DESC
      LIMIT ${limit}
    `;
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      snippet: snippetFrom(row.name, row.initialPrompt, q),
      status: row.status,
      phase: row.phase,
      updatedAt: row.updatedAt,
    }));
  }
}
