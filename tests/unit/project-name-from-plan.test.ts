import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A project's name was the raw prompt, hard-sliced at 40 characters. The measured
 * reproduction below produced `Build a landing page for "Chai Point", a` — cut mid-word,
 * ending on a dangling article — and that string is not cosmetic: it slugifies into the GitHub
 * repository name, the export archive filename and the published subdomain. The observed
 * `liveUrl` was `https://build-a-landing-page-for-chai-point-a.navroop.app`, which is the URL a
 * customer's site is served on.
 *
 * Two helpers answered the same question with different numbers — `nameFromPrompt`
 * (schema.ts, 40, hard slice) and `titleFromPrompt` (prompt.ts, 48, ellipsis, no caller) — and
 * only the first reached the database, which is how the disagreement stayed unnoticed. There
 * is one now, and the plan's subject overrides it once a plan exists.
 */

const REPRO_PROMPT =
  'Build a landing page for "Chai Point", a small tea cafe in Bangalore. Include a hero with ' +
  'the cafe name and tagline, a menu section with 6 drinks and prices, an about section, ' +
  'opening hours, and a contact form.';

const REPRO_SUMMARY =
  'A warm, minimal landing page for Chai Point, a small tea cafe in Bangalore. It leads with ' +
  'the cafe name and a tagline, then a menu of six drinks with prices.';

const PLAN_CONTENT = {
  summary: REPRO_SUMMARY,
  pages: [{ name: 'Home', description: 'Hero, menu, about, hours, contact.' }],
  keyFeatures: ['Menu with prices', 'Contact form'],
};

const OWNER = 'user_name_from_plan_owner';
const PROJECT_ID = 'project_name_from_plan';

const row = vi.hoisted(() => ({
  name: '',
  phase: 'PLANNING' as 'PLANNING' | 'BUILDING' | 'COMPLETE',
  lastCode: null as string | null,
  updatedAt: '2026-08-25T10:00:00.000Z',
}));
const projectUpdateMany = vi.hoisted(() => vi.fn());

vi.mock('@/lib/auth', () => ({
  getSessionUser: async () => ({ id: OWNER, email: 'chai@example.com', role: 'MEMBER' }),
}));

// react-toastify wants a document; `GenerationWorkspace`'s module graph reaches it and
// nothing in this file toasts.
vi.mock('@/lib/notify', () => ({
  notify: { loading: () => undefined, settle: () => undefined, error: () => undefined },
  toMessage: (_cause: unknown, fallback: string) => fallback,
}));

vi.mock('@/lib/db', () => ({
  prisma: {
    project: {
      // One row, carrying every column both readers select: `generatePlan` takes the five it
      // plans from, `getProject` takes the detail list. `select` is ignored here on purpose —
      // what `getProject` chooses to withhold is one of the things asserted below.
      findFirst: async () => ({
        id: PROJECT_ID,
        ownerId: OWNER,
        initialPrompt: REPRO_PROMPT,
        stack: 'NEXTJS',
        designDirection: null,
        name: row.name,
        phase: row.phase,
        lastCode: row.lastCode,
        status: 'draft',
        style: null,
        model: null,
        thumbnailUrl: null,
        createdAt: '2026-08-25T09:59:00.000Z',
        updatedAt: row.updatedAt,
        owner: { id: OWNER, name: 'Chai', email: 'chai@example.com', role: 'MEMBER' },
        importSource: null,
      }),
      updateMany: projectUpdateMany,
    },
    $transaction: async (fn: (tx: unknown) => unknown) =>
      fn({
        $executeRaw: async () => 0,
        projectPlan: {
          findFirst: async () => null,
          updateMany: async () => ({ count: 0 }),
          create: async ({ data }: { data: { content: unknown } }) => ({
            id: 'plan_1',
            version: 1,
            content: data.content,
          }),
        },
      }),
  },
}));

vi.mock('@/lib/jobs/lifecycle', () => ({
  createOrReuseJob: async () => ({ id: 'job_1', status: 'RUNNING' }),
  markJobRunning: async () => undefined,
  beginJobHeartbeat: () => ({ stop: () => undefined }),
  failJob: async () => undefined,
  succeedJob: async () => undefined,
}));

vi.mock('@/lib/storage/usage', () => ({ WORKSPACE_ROW_ID: 'workspace_1' }));
vi.mock('@/lib/usage-costs', () => ({ logGenerationEvent: async () => undefined }));
vi.mock('@/lib/memory/build-context', () => ({ buildMemoryBlock: async () => ({ block: '' }) }));
vi.mock('@/lib/skills/inject', () => ({ injectMatchedSkills: async () => ({ block: '' }) }));
vi.mock('@/lib/logger', () => ({
  log: { warn: () => undefined, info: () => undefined, error: () => undefined },
  logError: () => undefined,
}));

const { nameFromPlanSummary, nameFromPrompt, PROJECT_NAME_LIMIT, UNTITLED_PROJECT_NAME } =
  await import('@/lib/projects/prompt');
const promptModule = await import('@/lib/projects/prompt');
const schemaModule = await import('@/lib/projects/schema');
const { applyCreateProjectPlanFlow, runWithPlanCompleter } = await import('@/lib/projects/plan');
const { getProject } = await import('@/lib/projects/actions');
const { NAME_SETTLE_DELAYS_MS, settleTitleFromRead } = await import(
  '@/components/workspace/GenerationWorkspace'
);

/** `getProject` narrowed to the success shape these assertions read. */
async function readProject() {
  const result = await getProject(PROJECT_ID);
  if (!result.ok || !result.data) throw new Error('getProject did not return the project');
  return result.data;
}

/** Graphemes, so a cluster split shows up as a length the assertion did not expect. */
function clusters(value: string) {
  return Array.from(
    new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value),
    (part) => part.segment,
  );
}

beforeEach(() => {
  row.name = nameFromPrompt(REPRO_PROMPT);
  row.phase = 'PLANNING';
  row.lastCode = null;
  row.updatedAt = '2026-08-25T10:00:00.000Z';
  projectUpdateMany.mockReset();
  projectUpdateMany.mockImplementation(
    async ({ where, data }: { where: { name?: string }; data: { name: string } }) => {
      if (where.name !== undefined && where.name !== row.name) return { count: 0 };
      row.name = data.name;
      return { count: 1 };
    },
  );
});

describe('the reproduction that named a project after a truncated prompt', () => {
  it('never produces the sliced-mid-word name that reached the subdomain', () => {
    const name = nameFromPrompt(REPRO_PROMPT);
    expect(name).not.toBe('Build a landing page for "Chai Point", a');
    expect(name).toBe('Build a landing page for "Chai Point"…');
  });

  it('cuts on a word boundary and never ends on a dangling article or conjunction', () => {
    const cases = [
      REPRO_PROMPT,
      'Build me a modern portfolio website for a freelance photographer based in Oslo',
      'Make a booking site for a dentist and a hygienist with online payments and reminders',
      'Design a one page site for a bakery, a deli and a coffee bar in Leeds',
    ];
    for (const prompt of cases) {
      const name = nameFromPrompt(prompt);
      const words = name.replace(/…$/, '').split(' ');
      expect(words[words.length - 1]).not.toMatch(/^(a|an|the|and|with|for|or|of|to)$/i);
      expect(name).not.toMatch(/[,;:]…?$/);
      expect(clusters(name.replace(/…$/, '')).length).toBeLessThanOrEqual(PROJECT_NAME_LIMIT);
    }
  });

  it('names the project from the plan subject once the plan lands', async () => {
    expect(nameFromPlanSummary(REPRO_SUMMARY)).toBe('Chai Point');

    const result = await runWithPlanCompleter(
      async () => PLAN_CONTENT,
      () =>
        applyCreateProjectPlanFlow({
          projectId: PROJECT_ID,
          userId: OWNER,
          initialPrompt: REPRO_PROMPT,
          skipPlanning: false,
          provisionalName: nameFromPrompt(REPRO_PROMPT),
        }),
    );

    expect(result.name).toBe('Chai Point');
    expect(row.name).toBe('Chai Point');
  });
});

describe('an explicit name always wins', () => {
  it('does not rename when the user named the project at create', async () => {
    row.name = 'Tea shop';
    const result = await runWithPlanCompleter(
      async () => PLAN_CONTENT,
      () =>
        applyCreateProjectPlanFlow({
          projectId: PROJECT_ID,
          userId: OWNER,
          initialPrompt: REPRO_PROMPT,
          skipPlanning: false,
          // createProject passes null when the name came from the user, not the prompt.
          provisionalName: null,
        }),
    );

    expect(result.name).toBeNull();
    expect(projectUpdateMany).not.toHaveBeenCalled();
    expect(row.name).toBe('Tea shop');
  });

  it('does not clobber a rename the user made while the plan was in flight', async () => {
    const provisionalName = nameFromPrompt(REPRO_PROMPT);
    row.name = 'Renamed by the user';

    const result = await runWithPlanCompleter(
      async () => PLAN_CONTENT,
      () =>
        applyCreateProjectPlanFlow({
          projectId: PROJECT_ID,
          userId: OWNER,
          initialPrompt: REPRO_PROMPT,
          skipPlanning: false,
          provisionalName,
        }),
    );

    expect(projectUpdateMany).toHaveBeenCalledTimes(1);
    expect(projectUpdateMany.mock.calls[0]?.[0]?.where).toMatchObject({ name: provisionalName });
    expect(result.name).toBeNull();
    expect(row.name).toBe('Renamed by the user');
  });

  it('leaves the name alone when the plan names no subject', async () => {
    const result = await runWithPlanCompleter(
      async () => ({ ...PLAN_CONTENT, summary: 'A tidy single page site for a bakery.' }),
      () =>
        applyCreateProjectPlanFlow({
          projectId: PROJECT_ID,
          userId: OWNER,
          initialPrompt: REPRO_PROMPT,
          skipPlanning: false,
          provisionalName: nameFromPrompt(REPRO_PROMPT),
        }),
    );

    expect(result.name).toBeNull();
    expect(projectUpdateMany).not.toHaveBeenCalled();
  });
});

describe('the plan subject reader', () => {
  it('prefers a quoted phrase', () => {
    expect(nameFromPlanSummary('A storefront for "Bar Luna" with an online menu.')).toBe(
      'Bar Luna',
    );
  });

  it('reads a capitalised run introduced by for/called/named', () => {
    expect(nameFromPlanSummary('A booking site called Northwind Dental.')).toBe('Northwind Dental');
    expect(nameFromPlanSummary('A marketing site for Acme Robotics, a Boston startup.')).toBe(
      'Acme Robotics',
    );
  });

  it('refuses a stack or page name as the subject', () => {
    expect(nameFromPlanSummary('A landing page for Next.js with server components.')).toBeNull();
    expect(nameFromPlanSummary('A single page for Home and Contact.')).toBeNull();
  });

  it('returns null rather than guessing', () => {
    expect(nameFromPlanSummary('')).toBeNull();
    expect(nameFromPlanSummary(null)).toBeNull();
    expect(nameFromPlanSummary('   ')).toBeNull();
    expect(nameFromPlanSummary('A modern site for a neighbourhood bakery.')).toBeNull();
  });
});

describe('degenerate prompts still produce a usable name', () => {
  it('falls back to Untitled project for nothing at all', () => {
    expect(nameFromPrompt('')).toBe(UNTITLED_PROJECT_NAME);
    expect(nameFromPrompt('   \n\t  ')).toBe(UNTITLED_PROJECT_NAME);
  });

  it('names a URL import after its host, not a truncated URL', () => {
    expect(nameFromPrompt('https://stripe.com/pricing')).toBe('stripe.com');
    expect(nameFromPrompt('https://www.stripe.com/pricing/enterprise?ref=nav#plans')).toBe(
      'stripe.com',
    );
    expect(nameFromPrompt('example.com')).toBe('example.com');
    expect(nameFromPrompt('  https://shop.example.co.uk/collections/all  ')).toBe(
      'shop.example.co.uk',
    );
  });

  it('returns a short prompt unchanged', () => {
    expect(nameFromPrompt('Bakery site')).toBe('Bakery site');
    expect(nameFromPrompt('  Bakery   site  ')).toBe('Bakery site');
  });

  it('never returns an empty name for one very long token', () => {
    const token = 'x'.repeat(300);
    const name = nameFromPrompt(token);
    expect(name.replace(/…$/, '').length).toBe(PROJECT_NAME_LIMIT);
    expect(name).toMatch(/…$/);
  });

  it('never returns an empty name for a prompt made only of stopwords', () => {
    const name = nameFromPrompt('the and the and the and the and the and the and the and the');
    expect(name.replace(/…$/, '').trim().length).toBeGreaterThan(0);
  });

  it('never splits a grapheme cluster', () => {
    const family = '👨‍👩‍👧‍👦';
    const base = nameFromPrompt(family.repeat(60)).replace(/…$/, '');
    expect(base).toBe(family.repeat(base.length / family.length));

    const hindi =
      'एक छोटे चाय कैफ़े के लिए एक सुंदर लैंडिंग पृष्ठ बनाएँ जिसमें मेन्यू और संपर्क फ़ॉर्म हो';
    const hindiName = nameFromPrompt(hindi).replace(/…$/, '');
    expect(clusters(hindiName).length).toBeLessThanOrEqual(PROJECT_NAME_LIMIT);
    expect(hindi.startsWith(hindiName)).toBe(true);
  });

  it('keeps every name inside the project name column', () => {
    const prompts = [
      REPRO_PROMPT,
      '',
      'https://example.com/a/very/long/path/that/goes/on/and/on/forever/and/ever',
      'x'.repeat(500),
      '👨‍👩‍👧‍👦'.repeat(60),
    ];
    for (const prompt of prompts) {
      expect(clusters(nameFromPrompt(prompt)).length).toBeLessThanOrEqual(PROJECT_NAME_LIMIT + 1);
      expect(nameFromPrompt(prompt).trim()).not.toBe('');
    }
  });
});

describe('there is exactly one naming helper', () => {
  it('schema.ts re-exports the binding rather than defining a second one', () => {
    expect(schemaModule.nameFromPrompt).toBe(promptModule.nameFromPrompt);
  });

  it('no longer exports the 48-character twin that disagreed with it', () => {
    expect('titleFromPrompt' in promptModule).toBe(false);
  });
});

/**
 * Deriving the name correctly is half the fix; the other half is that the name reaches the
 * person looking at it.
 *
 * `deferPlanning: true` is what the dashboard sends, so it is the primary create path. It
 * answers the create before any plan exists, the router pushes `/project/{id}`, and the
 * workspace reads the row exactly once on mount — which is before `renameFromPlan` writes.
 * Nothing re-read it, so the workspace header showed
 * `Build a landing page for "Chai Point", a…` for the whole session while the dashboard and
 * the database showed `Chai Point`: the symptom the rename was added to remove, now with the
 * two views disagreeing.
 *
 * The delivery is `nameAwaitingPlan` on `getProject` — the server saying "this name is still
 * provisional" — plus the bounded settle watch in the workspace that reads once more and
 * stops. Both halves are driven here against the same row the plan flow renames.
 */
describe('the plan-derived rename reaches the open workspace', () => {
  it('tells the workspace its mount read got a provisional name', async () => {
    const mounted = await readProject();

    expect(mounted.name).toBe(nameFromPrompt(REPRO_PROMPT));
    expect(mounted.nameAwaitingPlan).toBe(true);
    // The one read the workspace makes on mount cannot show the plan's name, so a client that
    // treated it as final is exactly the defect.
    expect(settleTitleFromRead({ userRenamed: false, project: mounted })).toEqual({
      title: null,
      updatedAt: null,
      keepWatching: true,
    });
  });

  it('replaces the header title with the plan subject, with no reload', async () => {
    // 1. The workspace mounts and reads the row once.
    const mounted = await readProject();
    let shownTitle = mounted.name;
    expect(shownTitle).toBe('Build a landing page for "Chai Point"…');

    // 2. Seconds later the detached plan flow lands and renames the row.
    await runWithPlanCompleter(
      async () => PLAN_CONTENT,
      () =>
        applyCreateProjectPlanFlow({
          projectId: PROJECT_ID,
          userId: OWNER,
          initialPrompt: REPRO_PROMPT,
          skipPlanning: false,
          provisionalName: mounted.name,
        }),
    );
    row.updatedAt = '2026-08-25T10:00:12.000Z';

    // 3. The settle watch reads once more and hands the header the settled name.
    const settled = await readProject();
    const decision = settleTitleFromRead({ userRenamed: false, project: settled });
    if (decision.title) shownTitle = decision.title;

    expect(settled.nameAwaitingPlan).toBe(false);
    expect(shownTitle).toBe('Chai Point');
    // And it stops: nothing keeps reading once the name has settled.
    expect(decision.keepWatching).toBe(false);
    expect(decision.updatedAt).toBe('2026-08-25T10:00:12.000Z');
  });

  it('never reports a name the user typed as provisional', async () => {
    // `createProject` passes `provisionalName: null` for an explicit name, so the plan can
    // never write it. The flag has to agree, or the workspace would watch for a rename that
    // must not happen.
    row.name = 'Tea shop';
    expect((await readProject()).nameAwaitingPlan).toBe(false);
  });

  it('stops watching, and writes nothing, once this tab has renamed the project', async () => {
    const provisional = nameFromPrompt(REPRO_PROMPT);
    // A read that was already in flight when the rename PATCH landed still answers with the
    // row's older name. Painting that back over what the person just typed is the one thing
    // the watch must never do.
    expect(
      settleTitleFromRead({
        userRenamed: true,
        project: { name: provisional, updatedAt: row.updatedAt, nameAwaitingPlan: true },
      }),
    ).toEqual({ title: null, updatedAt: null, keepWatching: false });
  });

  it('does not arm for a URL import or a skip-planning create', async () => {
    // Both are inserted BUILDING, and neither ever calls `renameFromPlan`.
    row.phase = 'BUILDING';
    expect((await readProject()).nameAwaitingPlan).toBe(false);
  });

  it('does not arm for a follow-up plan on a project that already has a site', async () => {
    // `requestFollowUpPlan` puts a finished project back into PLANNING, but the rename only
    // ever runs on a first plan, so there is nothing here to wait for.
    row.lastCode = '<file path="app/page.tsx">export default function Page() {}</file>';
    expect((await readProject()).nameAwaitingPlan).toBe(false);
  });

  it('does not arm on the non-deferred path, where the rename landed before the mount', async () => {
    // `createProject` without `deferPlanning` awaits the plan, so the row is already renamed
    // by the time the workspace reads it.
    await runWithPlanCompleter(
      async () => PLAN_CONTENT,
      () =>
        applyCreateProjectPlanFlow({
          projectId: PROJECT_ID,
          userId: OWNER,
          initialPrompt: REPRO_PROMPT,
          skipPlanning: false,
          provisionalName: nameFromPrompt(REPRO_PROMPT),
        }),
    );

    const mounted = await readProject();
    expect(mounted.name).toBe('Chai Point');
    expect(mounted.nameAwaitingPlan).toBe(false);
  });

  it('keeps the prompt off the payload it computes the flag from', async () => {
    // The detail read is curated (F-809). `initialPrompt` is selected only so the flag can be
    // computed, and must not become a new column the endpoint publishes.
    expect('initialPrompt' in (await readProject())).toBe(false);
  });

  it('treats an unreadable row as unknown rather than settled', () => {
    // Offline, or a 502. Concluding "settled" there would end the watch on no evidence.
    expect(settleTitleFromRead({ userRenamed: false, project: null })).toEqual({
      title: null,
      updatedAt: null,
      keepWatching: true,
    });
  });

  it('watches with a bounded back-off rather than a fourth poll', () => {
    // The workspace already reads the project, the plan and the job every 5s during PLANNING.
    // This must cost a fraction of that, terminate on its own, and cost nothing when idle.
    const total = NAME_SETTLE_DELAYS_MS.reduce((sum, delay) => sum + delay, 0);
    expect(NAME_SETTLE_DELAYS_MS.length).toBeLessThanOrEqual(10);
    expect(NAME_SETTLE_DELAYS_MS.every((delay) => delay > 0)).toBe(true);
    // Ascending: dense where plans land, sparse afterwards.
    expect([...NAME_SETTLE_DELAYS_MS].sort((a, b) => a - b)).toEqual(NAME_SETTLE_DELAYS_MS);
    expect(total).toBeGreaterThan(60_000);
    // The plan, job and project polls already run at 5s each during PLANNING. Over the span
    // this back-off covers, the watch must cost a small fraction of what they already cost.
    const alreadyPolled = (total / 5000) * 3;
    expect(NAME_SETTLE_DELAYS_MS.length * 5).toBeLessThan(alreadyPolled);
  });
});
