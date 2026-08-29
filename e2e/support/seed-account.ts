/**
 * Seeds the accounts and rows the authenticated Playwright journeys need.
 *
 * Navroop is invite-only, so registration is not a path: rows are written
 * straight through Prisma. The password hash comes from
 * `lib/password.hashPassword` — the same function `auth.ts` verifies against —
 * so this cannot drift from the real credentials provider.
 *
 * Everything here is idempotent and keyed on a unique column, because the setup
 * project runs before every Playwright invocation and the journeys re-seed their
 * own fixtures. `resolveE2eTarget` decides which database may receive any of it.
 */
// Explicit `index.js`: Playwright's ESM loader does not resolve a relative
// directory import, and the generated client's `exports` map only applies to
// package-name imports.
import { PrismaClient } from '../../generated/prisma/index.js';
import { TERMS_VERSION } from '../../lib/legal/terms';
import { hashPassword } from '../../lib/password';
import { loadPlaywrightDotenv } from '../../lib/verify/playwright-env';
import { adminAccountFor, resolveE2eTarget, type E2eAccount } from './account';

export type SeedResult = {
  account: E2eAccount;
  database: string;
  created: boolean;
};

/** Same single-row ledger id as `lib/storage/usage.WORKSPACE_ROW_ID`. */
const WORKSPACE_ID = 'default';

/** Slug of the template journey 8 opens. Distinctive so it cannot collide with a built-in. */
export const E2E_TEMPLATE_SLUG = 'e2e-journey-template';
export const E2E_TEMPLATE_NAME = 'E2E journey template';
export const E2E_TEMPLATE_DESCRIPTION =
  'Seeded by the Playwright journeys. Safe to delete — the setup project writes it back.';
export const E2E_TEMPLATE_PROMPT =
  'A one-page site for a canal-side bookshop, with opening hours and a stock enquiry form.';

/**
 * Opens a client against the resolved application database.
 *
 * The target is re-resolved on every call rather than cached: the guards in
 * `account.ts` are the only thing standing between a fixture and the Vitest
 * database, and a cached client would carry a decision made under a different
 * environment.
 */
async function withE2ePrisma<T>(
  work: (prisma: PrismaClient, target: { database: string }) => Promise<T>,
): Promise<T> {
  loadPlaywrightDotenv();

  const resolved = resolveE2eTarget(process.env);
  if (!resolved.ok) {
    throw new Error(resolved.error);
  }

  const prisma = new PrismaClient({
    datasourceUrl: resolved.target.databaseUrl,
    log: ['error'],
  });
  try {
    return await work(prisma, { database: resolved.target.database });
  } finally {
    await prisma.$disconnect();
  }
}

/** The two identities the journeys sign in as, without touching the database. */
export function e2eAccounts(): { member: E2eAccount; admin: E2eAccount } {
  loadPlaywrightDotenv();
  const resolved = resolveE2eTarget(process.env);
  if (!resolved.ok) throw new Error(resolved.error);
  return { member: resolved.target.account, admin: adminAccountFor(resolved.target.account) };
}

/**
 * One `upsert` keyed on the unique email. A second run rewrites the hash (bcrypt
 * salts every call, so the value differs and both verify) and puts the row back
 * into a signed-in-able state — active, the role asked for, terms accepted — in
 * case an earlier test or an admin screen changed it.
 *
 * `passwordChangedAt` is deliberately left alone: `auth.ts` rejects any JWT
 * issued before it, so stamping it here would invalidate a storage state that is
 * still perfectly good.
 */
async function upsertAccount(
  prisma: PrismaClient,
  account: E2eAccount,
  role: 'MEMBER' | 'ADMIN',
): Promise<boolean> {
  const before = await prisma.user.findUnique({
    where: { email: account.email },
    select: { id: true },
  });
  const passwordHash = await hashPassword(account.password);
  const acceptedAt = new Date();
  const fields = {
    name: account.name,
    passwordHash,
    role,
    isActive: true,
    termsAcceptedAt: acceptedAt,
    termsVersion: TERMS_VERSION,
  };

  await prisma.user.upsert({
    where: { email: account.email },
    update: fields,
    create: { email: account.email, ...fields },
  });

  return before === null;
}

/** The MEMBER the `authenticated` project's storage state belongs to. */
/**
 * The plan the journeys assume, made explicit instead of inherited from
 * whatever the database's default plan happens to be. Two journeys read plan
 * fields directly: journey 5 renders the Domains panel only when the effective
 * plan has `allowCustomDomain` (the seeded `free` default does not, so on a
 * freshly seeded database it rendered its plan lock), and journey 7's invite is
 * refused once the member count reaches `maxMembers` (`free` allows 2, and the
 * E2E member + admin already exist). Both passed locally only because that
 * machine's long-lived default plan drifted generous. A dedicated plan row,
 * assigned to the shared `default` workspace, pins the assumption; the seeded
 * built-in plans are left exactly as the product ships them.
 */
const E2E_PLAN_KEY = 'e2e-journeys';

async function ensureJourneyPlan(prisma: PrismaClient): Promise<void> {
  const plan = await prisma.plan.upsert({
    where: { key: E2E_PLAN_KEY },
    create: {
      key: E2E_PLAN_KEY,
      name: 'E2E journeys',
      isActive: true,
      isDefault: false,
      monthlyCredits: 10_000,
      maxProjects: 500,
      maxLiveSites: 50,
      maxPreviewSites: 50,
      maxMembers: 50,
      checkpointRetentionDays: 30,
      storageBytesLimit: BigInt(50) * BigInt(1024 ** 3),
      allowCustomDomain: true,
      allowGithubSync: true,
    },
    // Re-pin the two fields the journeys read, in case an admin screen or an
    // earlier run changed them; everything else keeps whatever it has.
    update: { isActive: true, allowCustomDomain: true, maxMembers: 50 },
  });
  await prisma.workspace.upsert({
    where: { id: WORKSPACE_ID },
    create: { id: WORKSPACE_ID, storageBytes: 0, planId: plan.id },
    update: { planId: plan.id },
  });
}

export async function seedE2eAccount(): Promise<SeedResult> {
  return withE2ePrisma(async (prisma, target) => {
    const { member } = e2eAccounts();
    const created = await upsertAccount(prisma, member, 'MEMBER');
    await ensureJourneyPlan(prisma);
    return { account: member, database: target.database, created };
  });
}

/**
 * The ADMIN half of journey 7. Kept a separate row rather than promoting the
 * member: the journeys run fully parallel, so flipping the shared account's role
 * mid-run would decide the MEMBER-is-refused assertion in another worker.
 */
export async function seedE2eAdminAccount(): Promise<SeedResult> {
  return withE2ePrisma(async (prisma, target) => {
    const { admin } = e2eAccounts();
    const created = await upsertAccount(prisma, admin, 'ADMIN');
    return { account: admin, database: target.database, created };
  });
}

/**
 * Removes an account the invite journey created through the real admin API,
 * along with the Invite row that route writes beside it.
 *
 * Deleting rather than deactivating: the next run invites the same address, and
 * `POST /api/admin/invite` answers 409 for any existing row, active or not.
 */
export async function deleteE2eUser(email: string): Promise<void> {
  await withE2ePrisma(async (prisma) => {
    await prisma.invite.deleteMany({ where: { email } });
    await prisma.user.deleteMany({ where: { email } });
  });
}

/**
 * A settled-but-unfinished BUILD job on `projectId`, which is what opens the
 * chat recovery panel (`isChatRecoveryStatus` in `lib/jobs/chat-ui.ts`).
 *
 * `errorCode` is `server_restarted` because that is the abandonment the reaper
 * writes and it has a curated cause line, so the journey can assert the panel
 * names the cause instead of only its heading. `filesWritten` is non-zero so the
 * keep-what-was-built branch renders too.
 */
export async function seedAbandonedBuildJob(input: {
  projectId: string;
  ownerEmail: string;
}): Promise<{ jobId: string }> {
  return withE2ePrisma(async (prisma) => {
    const owner = await prisma.user.findUnique({
      where: { email: input.ownerEmail },
      select: { id: true },
    });
    if (!owner) throw new Error(`No user row for ${input.ownerEmail}; seed the account first.`);

    await prisma.workspace.upsert({
      where: { id: WORKSPACE_ID },
      create: { id: WORKSPACE_ID, storageBytes: 0 },
      update: {},
    });

    const job = await prisma.job.create({
      data: {
        projectId: input.projectId,
        workspaceId: WORKSPACE_ID,
        userId: owner.id,
        kind: 'BUILD',
        status: 'ABANDONED',
        startedAt: new Date(Date.now() - 60_000),
        finishedAt: new Date(),
        filesWritten: 3,
        errorCode: 'server_restarted',
        inputPrompt: 'Add a contact section',
      },
      select: { id: true },
    });
    return { jobId: job.id };
  });
}

/**
 * The template journey 8 opens, so the journey does not depend on which
 * built-ins happen to be seeded in this database. `workspaceId` is the shared
 * ledger row so `isVisibleToWorkspace` accepts it for a normal member.
 */
export async function seedE2eTemplate(): Promise<{ id: string; prompt: string }> {
  return withE2ePrisma(async (prisma) => {
    const fields = {
      name: E2E_TEMPLATE_NAME,
      description: E2E_TEMPLATE_DESCRIPTION,
      category: 'business',
      stack: 'NEXTJS' as const,
      prompt: E2E_TEMPLATE_PROMPT,
      isActive: true,
      isBuiltIn: false,
      workspaceId: WORKSPACE_ID,
    };
    const row = await prisma.template.upsert({
      where: { slug: E2E_TEMPLATE_SLUG },
      update: fields,
      create: { slug: E2E_TEMPLATE_SLUG, ...fields },
      select: { id: true, prompt: true },
    });
    return row;
  });
}
