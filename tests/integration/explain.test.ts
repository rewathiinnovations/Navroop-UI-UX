import '../setup/env';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testPrismaClient } from '../setup/db';
import { hashPassword } from '@/lib/password';

/**
 * The hot read paths are only fast because Postgres reaches them through an index
 * rather than scanning the whole table:
 *
 *  - project search (`lib/search/projects.ts`) filters `searchVector @@ tsquery`,
 *    served by the GIN index `Project_searchVector_idx`.
 *  - presence (`lib/projects/presence.ts` -> `listRecentPresence`) filters
 *    `"projectId" = $1`, served by the composite btree `@@index([projectId, lastSeenAt])`.
 *
 * The previous file was two `expect(true).toBe(true)` calls — it opened no
 * connection and could not fail, so a dropped index shipped green while the
 * "EXPLAIN seq-scan check" name still claimed coverage. This seeds real rows,
 * ANALYZEs, and asserts each query plans through its index rather than a Seq Scan.
 * Drop either index and the matching case turns red.
 *
 * Presence is asserted under the default planner: a selective equality on an
 * indexed column at this row count is cheaper as an index scan, so the planner
 * chooses it on its own. GIN is different — its estimated startup cost scales with
 * the index size, so for a single-row tsquery match the planner does not prefer it
 * over a seq scan until the table is very large (tens of thousands of rows), which
 * is not a row count a gate should pay for every run. The search case therefore
 * asserts the weaker-but-deterministic contract that matters day to day: the GIN
 * index EXISTS and SERVES the tsquery. With seq scan disabled for that one
 * statement, the only plan that avoids a Seq Scan is one that uses
 * `Project_searchVector_idx`; drop the index and the plan falls back to a Seq Scan
 * even then, failing the case.
 *
 * `listReconcileCandidates` is the third hot query the name implies, but its
 * predicate wraps the indexed column in `COALESCE("heartbeatAt","createdAt")`,
 * which is not directly index-scannable — a seq-scan assertion on it would be a
 * false gate, not coverage, so it is deliberately left out.
 */

const prisma = testPrismaClient();

// Scoped to this suite so it is safe under Vitest's parallel file execution and does
// not depend on rows another suite left behind (F-606/F-607). Alphanumeric ids and a
// nonce term are inlined into the EXPLAIN text below, so they must stay injection-safe.
const suffix = `${Date.now()}${Math.random().toString(16).slice(2, 10)}`.replace(/[^a-z0-9]/gi, '');
const OWNER_ID = `explainowner${suffix}`;
const OWNER_EMAIL = `explain-${suffix}@example.com`;
const NONCE = `zqxplain${suffix}`;
const TARGET_PROJECT_ID = `explaintarget${suffix}`;
// Enough presence rows that a selective equality is cheaper as an index scan than a
// full scan under the default planner; the seeded set is scoped so it never leaks.
const FILLER_PROJECTS = 1500;

type PlanNode = {
  'Node Type'?: string;
  'Relation Name'?: string;
  Plans?: PlanNode[];
};

function nodeFor(plan: PlanNode, relation: string): PlanNode | null {
  if (plan['Relation Name'] === relation) return plan;
  for (const child of plan.Plans ?? []) {
    const found = nodeFor(child, relation);
    if (found) return found;
  }
  return null;
}

async function explainPlan(sql: string, opts: { noSeqscan?: boolean } = {}): Promise<PlanNode> {
  // One connection for the SET LOCAL and the EXPLAIN: an interactive transaction, so the
  // planner setting actually applies to the statement being explained.
  return prisma.$transaction(async (tx) => {
    if (opts.noSeqscan) {
      await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
    }
    const rows = await tx.$queryRawUnsafe<Array<{ 'QUERY PLAN': Array<{ Plan: PlanNode }> }>>(
      `EXPLAIN (FORMAT JSON) ${sql}`,
    );
    return rows[0]['QUERY PLAN'][0].Plan;
  });
}

beforeAll(async () => {
  const passwordHash = await hashPassword('explain-index-test');
  await prisma.user.create({
    data: { id: OWNER_ID, email: OWNER_EMAIL, name: 'Explain Owner', passwordHash, role: 'MEMBER' },
  });

  // Filler rows so the tables are large enough for the presence index to pay off. None
  // carry the nonce, so exactly one row matches the tsquery — maximally selective.
  const filler = Array.from({ length: FILLER_PROJECTS }, (_, i) => ({
    name: `Explain filler ${suffix} ${i}`,
    initialPrompt: `A generic landing page for shop number ${i}`,
    ownerId: OWNER_ID,
  }));
  for (let i = 0; i < filler.length; i += 500) {
    await prisma.project.createMany({ data: filler.slice(i, i + 500) });
  }

  await prisma.project.create({
    data: {
      id: TARGET_PROJECT_ID,
      name: `Explain target ${suffix}`,
      initialPrompt: `The definitive ${NONCE} project`,
      ownerId: OWNER_ID,
    },
  });

  // One presence row per project so the ProjectPresence table is large, with the target
  // project holding exactly one — a selective equality on "projectId".
  const allProjects = await prisma.project.findMany({
    where: { ownerId: OWNER_ID },
    select: { id: true },
  });
  const presenceRows = allProjects.map((p) => ({ projectId: p.id, userId: OWNER_ID }));
  for (let i = 0; i < presenceRows.length; i += 500) {
    await prisma.projectPresence.createMany({ data: presenceRows.slice(i, i + 500) });
  }

  await prisma.$executeRawUnsafe('ANALYZE "Project"');
  await prisma.$executeRawUnsafe('ANALYZE "ProjectPresence"');
});

afterAll(async () => {
  // Cascades remove the seeded projects, presence and the owner's rows.
  await prisma.user.deleteMany({ where: { id: OWNER_ID } });
  await prisma.$disconnect();
});

describe('hot-read query plans use their index', () => {
  it('the project search tsquery is served by Project_searchVector_idx, not a seq scan', async () => {
    const plan = await explainPlan(
      `SELECT p.id
         FROM "Project" p
        WHERE p."searchVector" @@ websearch_to_tsquery('english', '${NONCE}')`,
      { noSeqscan: true },
    );
    const project = nodeFor(plan, 'Project');
    expect(project, 'the plan must touch the Project relation').not.toBeNull();
    expect(project?.['Node Type']).not.toBe('Seq Scan');
    // Name the index: a rename or a dropped GIN index (not merely "some index") is what
    // this must catch — with seq scan disabled, the fallback is still a Seq Scan.
    expect(JSON.stringify(plan)).toContain('Project_searchVector_idx');
  });

  it('presence lookup plans as an index scan on ProjectPresence', async () => {
    const plan = await explainPlan(
      `SELECT p."userId"
         FROM "ProjectPresence" p
        WHERE p."projectId" = '${TARGET_PROJECT_ID}'
          AND p."lastSeenAt" > NOW() - INTERVAL '90 seconds'`,
    );
    const presence = nodeFor(plan, 'ProjectPresence');
    expect(presence, 'the plan must touch the ProjectPresence relation').not.toBeNull();
    expect(presence?.['Node Type']).not.toBe('Seq Scan');
  });
});
