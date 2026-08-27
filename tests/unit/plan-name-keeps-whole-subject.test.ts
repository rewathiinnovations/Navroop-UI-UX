import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * MEASURED, driving the real app. The prompt was
 *   `Build a landing page for "Kettle & Co", a specialty coffee roastery in Pune. …`
 * the plan came back describing
 *   `A Swiss-style landing page for Kettle & Co, a specialty coffee roastery in Pune, …`
 * and the project was named, in the database and in the workspace header, `Kettle`.
 *
 * The subject run ended at the ampersand: `&` is edge punctuation, so stripping a token's
 * edges turned the standalone `&` into an empty string, which is not a subject word, which
 * ended the run. Half a business name is not recoverable downstream — the project name is the
 * sidebar entry, the GitHub repository name, the export archive filename and the published
 * subdomain, and every one of those slugifies whatever it is handed.
 *
 * So this file pins two things that have to hold together: the derived name is the whole
 * subject, punctuation and all, and each downstream target sanitises that name for itself
 * rather than relying on it having been pre-damaged for all of them.
 */

const OWNER = 'user_kettle_owner';
const PROJECT_ID = 'project_kettle';

const REPRO_PROMPT =
  'Build a landing page for "Kettle & Co", a specialty coffee roastery in Pune. Include a ' +
  'hero with the roastery name, a beans section, an about section and a contact form.';

const REPRO_SUMMARY =
  'A Swiss-style landing page for Kettle & Co, a specialty coffee roastery in Pune, ' +
  'featuring a hero, a beans grid and a contact form.';

const PLAN_CONTENT = {
  summary: REPRO_SUMMARY,
  pages: [{ name: 'Home', description: 'Hero, beans, about, contact.' }],
  keyFeatures: ['Beans grid', 'Contact form'],
};

const row = vi.hoisted(() => ({ name: '' }));
const projectUpdateMany = vi.hoisted(() => vi.fn());

vi.mock('@/lib/auth', () => ({
  getSessionUser: async () => ({ id: OWNER, email: 'kettle@example.com', role: 'MEMBER' }),
}));

vi.mock('@/lib/db', () => ({
  prisma: {
    project: {
      findFirst: async () => ({
        id: PROJECT_ID,
        ownerId: OWNER,
        initialPrompt: REPRO_PROMPT,
        stack: 'NEXTJS',
        designDirection: null,
        name: row.name,
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

const { nameFromPlanSummary, nameFromPrompt, PROJECT_NAME_LIMIT } = await import(
  '@/lib/projects/prompt'
);
const { applyCreateProjectPlanFlow, runWithPlanCompleter } = await import('@/lib/projects/plan');
const { slugifyRepoName } = await import('@/lib/github/repo-name');
const { buildExportFilename, slugifyExportName } = await import('@/lib/export/filename');
const { slugCandidate, slugFromName } = await import('@/lib/publish/slug');
const { slugify } = await import('@/lib/deploy/repo-files');

/** Graphemes, so a cluster split shows up as a length the assertion did not expect. */
function clusters(value: string) {
  return Array.from(
    new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value),
    (part) => part.segment,
  );
}

beforeEach(() => {
  row.name = nameFromPrompt(REPRO_PROMPT);
  projectUpdateMany.mockReset();
  projectUpdateMany.mockImplementation(
    async ({ where, data }: { where: { name?: string }; data: { name: string } }) => {
      if (where.name !== undefined && where.name !== row.name) return { count: 0 };
      row.name = data.name;
      return { count: 1 };
    },
  );
});

describe('the reproduction that named the project after half a business', () => {
  it('keeps the whole subject, ampersand and all', () => {
    expect(nameFromPlanSummary(REPRO_SUMMARY)).toBe('Kettle & Co');
    expect(nameFromPlanSummary(REPRO_SUMMARY)).not.toBe('Kettle');
  });

  it('writes the whole subject to the project row', async () => {
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

    expect(result.name).toBe('Kettle & Co');
    expect(row.name).toBe('Kettle & Co');
  });

  it('reads the same subject out of the quoted prompt form', () => {
    // The quoted branch is tried first and must not lose the ampersand either — a plan that
    // echoes the prompt's own quotes takes this path rather than the introduced-run one.
    expect(nameFromPlanSummary('A landing page for "Kettle & Co" with a beans grid.')).toBe(
      'Kettle & Co',
    );
  });
});

describe('a business name is allowed to look like a business name', () => {
  it('joins the halves of a name across &, + and and', () => {
    expect(nameFromPlanSummary('A site for Kettle & Co, a roastery in Pune.')).toBe('Kettle & Co');
    expect(nameFromPlanSummary('A shopfront for Smith + Sons, a joinery in Leeds.')).toBe(
      'Smith + Sons',
    );
    expect(nameFromPlanSummary('A menu site for Ben and Jerry, a diner in Hove.')).toBe(
      'Ben and Jerry',
    );
  });

  it('keeps an apostrophe, a hyphen and an internal dot', () => {
    expect(nameFromPlanSummary("A booking site for O'Brien Dental, a practice in Cork.")).toBe(
      "O'Brien Dental",
    );
    expect(nameFromPlanSummary('A landing page for Well-Being Studio, a yoga room.')).toBe(
      'Well-Being Studio',
    );
    expect(nameFromPlanSummary('A storefront for Acme.io, a hardware shop.')).toBe('Acme.io');
  });

  it('reads a name in a script that has no upper case', () => {
    // `'カ' === 'カ'.toLowerCase()`, so a rule that demands a case distinction refuses every
    // name written in CJK, Devanagari, Arabic, Hebrew or Thai.
    expect(nameFromPlanSummary('A landing page for カフェ月, a coffee bar in Kyoto.')).toBe(
      'カフェ月',
    );
    expect(nameFromPlanSummary('A landing page for चाय घर, a tea room in Pune.')).toBe('चाय घर');
  });

  it('ends the run where the business name ends', () => {
    // A connector is held, not emitted: it joins only once another subject word follows.
    expect(nameFromPlanSummary('A site for Acme and its customers in Leeds.')).toBe('Acme');
    // A second capitalised clause after a comma is a different clause, not more of the name.
    expect(nameFromPlanSummary('A site for Acme, Bright Ideas and more.')).toBe('Acme');
  });
});

describe('a subject that is not a name is refused rather than guessed at', () => {
  it('refuses punctuation, filler and page lists', () => {
    expect(nameFromPlanSummary('A landing page for &&& — a shop of some kind.')).toBeNull();
    expect(nameFromPlanSummary('A one page site for "& + &".')).toBeNull();
    expect(nameFromPlanSummary('A single page for Home and Contact.')).toBeNull();
    expect(nameFromPlanSummary('A landing page for Next.js and React.')).toBeNull();
  });

  it('refuses a summary that names no subject at all', () => {
    expect(nameFromPlanSummary('A modern site for a neighbourhood bakery.')).toBeNull();
    expect(nameFromPlanSummary('')).toBeNull();
    expect(nameFromPlanSummary('   ')).toBeNull();
    expect(nameFromPlanSummary(null)).toBeNull();
    expect(nameFromPlanSummary(undefined)).toBeNull();
  });

  it('leaves the provisional name alone when the plan names no subject', async () => {
    const provisional = nameFromPrompt(REPRO_PROMPT);
    const result = await runWithPlanCompleter(
      async () => ({ ...PLAN_CONTENT, summary: 'A tidy single page site for a roastery.' }),
      () =>
        applyCreateProjectPlanFlow({
          projectId: PROJECT_ID,
          userId: OWNER,
          initialPrompt: REPRO_PROMPT,
          skipPlanning: false,
          provisionalName: provisional,
        }),
    );

    expect(result.name).toBeNull();
    expect(projectUpdateMany).not.toHaveBeenCalled();
    expect(row.name).toBe(provisional);
  });

  it('cuts a very long subject to the column, on a word boundary, without splitting a cluster', () => {
    const long = nameFromPlanSummary(
      'A supporters site for Wolverhampton Wanderers Football Club Supporters Trust, a fan group.',
    );
    expect(long).not.toBeNull();
    expect(clusters(long ?? '').length).toBeLessThanOrEqual(PROJECT_NAME_LIMIT + 1);
    expect(long).toMatch(/…$/);
    expect(long?.replace(/…$/, '')).not.toMatch(/[\s&+]$/);

    // Graphemes, not UTF-16 units. A cut through a Devanagari cluster leaves an orphaned
    // combining mark in a name that goes on to become a repository name and a DNS label.
    const subject = 'चाय'.repeat(30);
    const devanagari = nameFromPlanSummary(`A tea site for ${subject}, a tea room in Pune.`);
    const base = (devanagari ?? '').replace(/…$/, '');
    expect(clusters(base).length).toBe(PROJECT_NAME_LIMIT);
    expect(subject.startsWith(base)).toBe(true);
  });
});

/**
 * The display name is not pre-slugged for anybody. Each target strips what *it* cannot take
 * and has its own fallback for a name that leaves it nothing, which is exactly what lets the
 * stored name keep an ampersand, an apostrophe or a non-Latin script.
 */
describe('every downstream target sanitises the name for itself', () => {
  const NAME = 'Kettle & Co';

  it('turns the ampersand into a separator rather than a truncation', () => {
    expect(slugifyRepoName(NAME)).toBe('kettle-co');
    expect(slugifyExportName(NAME)).toBe('kettle-co');
    expect(slugFromName(NAME)).toBe('kettle-co');
    expect(slugify(NAME)).toBe('kettle-co');
    expect(buildExportFilename(NAME, new Date('2026-08-27T00:00:00.000Z'))).toBe(
      'kettle-co-2026-08-27.zip',
    );
    expect(slugCandidate(NAME, 1)).toBe('kettle-co');
  });

  it('produces a legal DNS label, repo name and npm name for every name we allow', () => {
    const names = [
      NAME,
      'Smith + Sons',
      "O'Brien Dental",
      'Well-Being Studio',
      'Acme.io',
      'カフェ月',
      'चाय घर',
      '👨‍👩‍👧‍👦 family store',
      'Wolverhampton Wanderers Football Club Supporters…',
    ];
    for (const name of names) {
      // A DNS label: lower-case alphanumerics and inner hyphens, never empty, never longer
      // than the 40 the slug column allows. An empty label would publish on `.navroop.app`.
      const label = slugFromName(name);
      expect(label).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(label.length).toBeGreaterThan(0);
      expect(label.length).toBeLessThanOrEqual(40);

      // A GitHub repository name and an npm package name: same alphabet, own fallbacks.
      expect(slugifyRepoName(name)).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(slugify(name)).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);

      // An archive filename with no path or shell metacharacters in it.
      expect(buildExportFilename(name)).toMatch(/^[a-z0-9-]+-\d{4}-\d{2}-\d{2}\.zip$/);
    }
  });

  it('falls back per target when a name slugifies to nothing', () => {
    // Each has its own word for "nothing left", and none of them is the empty string.
    expect(slugFromName('カフェ月')).toBe('site');
    expect(slugifyRepoName('カフェ月')).toBe('project');
    expect(slugifyExportName('カフェ月')).toBe('project');
    expect(slugify('カフェ月')).toBe('app');
    expect(slugFromName('&&&')).toBe('site');
    expect(slugifyRepoName('&&&')).toBe('project');
  });
});
