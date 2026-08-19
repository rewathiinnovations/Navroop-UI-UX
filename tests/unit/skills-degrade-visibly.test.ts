import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { injectMatchedSkills } from '@/lib/skills/inject';
import { selectSkills } from '@/lib/skills/match';

/**
 * Skill selection and injection are non-throwing by contract: a generation must
 * still run when nothing can be matched. Both entry points used to end in a bare
 * `catch {}`, so the failures that are *not* "nothing matched" — a provider
 * 429/500 inside the ranker, a rankSchema parse miss, a blip on
 * `prisma.skill.findMany` — removed the whole feature with zero evidence. No
 * injected block, no `skills` progress event, `usageCount` flat on /admin/usage,
 * and nothing for the admin who reports "my skill never applies".
 *
 * These cases pin both halves: still no throw, and a structured warn line naming
 * the failure. Every degraded case is paired with a healthy control, so a
 * permanently-broken path cannot pass itself off as a well-behaved degradation.
 */

const db = vi.hoisted(() => ({
  skillFindMany: vi.fn(),
  skillUpdateMany: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  prisma: { skill: { findMany: db.skillFindMany, updateMany: db.skillUpdateMany } },
}));

type Candidate = {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  updatedAt: Date;
};

const UPDATED = new Date('2026-08-19T00:00:00.000Z');

function candidate(id: string, name: string, description: string): Candidate {
  return { id, name, description, enabled: true, updatedAt: UPDATED };
}

const LANDING = candidate(
  'landing',
  'Landing page structure',
  'Hero and pricing sections for a marketing landing page',
);
const FORM = candidate('form', 'Form validation', 'Inline field errors and submit states');
const TABLE = candidate('table', 'Data tables', 'Sortable columns and server pagination');
const SEO = candidate('seo', 'SEO metadata', 'Titles, descriptions and open graph tags');

/** Four enabled skills is above KEYWORD_SHORT_CIRCUIT, so the ranker really runs. */
const RANKED_CATALOG = [LANDING, FORM, TABLE, SEO];

const MESSAGE = 'a pricing landing page';

let lines: string[];

function loggedEvent(event: string) {
  const line = lines.find((text) => text.includes(`"event":"${event}"`));
  return line ? (JSON.parse(line) as Record<string, unknown>) : null;
}

beforeEach(() => {
  vi.clearAllMocks();
  lines = [];
  vi.spyOn(console, 'warn').mockImplementation((line: unknown) => lines.push(String(line)));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('selectSkills when selection fails', () => {
  it('degrades to no skills and logs skills.selection_failed on a ranker error', async () => {
    const matched = await selectSkills(MESSAGE, '', {
      listEnabled: async () => RANKED_CATALOG,
      ranker: async () => {
        throw new Error('429 Too Many Requests');
      },
    });

    // Non-throwing contract: the generation this sits in front of is unaffected.
    expect(matched).toEqual([]);
    expect(loggedEvent('skills.selection_failed')).toMatchObject({
      level: 'warn',
      error: '429 Too Many Requests',
    });
  });

  it('logs the same event when listing the enabled skills fails', async () => {
    const matched = await selectSkills(MESSAGE, '', {
      listEnabled: async () => {
        throw new Error('database connection terminated');
      },
    });

    expect(matched).toEqual([]);
    expect(loggedEvent('skills.selection_failed')).toMatchObject({
      error: 'database connection terminated',
    });
  });

  it('still ranks normally, and logs nothing, when the ranker answers', async () => {
    const matched = await selectSkills(MESSAGE, '', {
      listEnabled: async () => RANKED_CATALOG,
      ranker: async () => [{ id: 'landing', confidence: 0.9 }],
    });

    expect(matched.map((skill) => skill.id)).toEqual(['landing']);
    expect(loggedEvent('skills.selection_failed')).toBeNull();
  });
});

describe('injectMatchedSkills when the database fails mid-injection', () => {
  /** Two enabled skills stays on the keyword short-circuit — no provider call. */
  function stubMatchAndContent() {
    db.skillFindMany
      .mockResolvedValueOnce([LANDING, FORM])
      .mockResolvedValueOnce([
        { id: 'landing', name: LANDING.name, content: 'Open with a hero, then pricing.' },
      ]);
  }

  it('returns an empty block and logs skills.injection_failed', async () => {
    stubMatchAndContent();
    db.skillUpdateMany.mockRejectedValue(new Error('deadlock detected'));

    const injected = await injectMatchedSkills(MESSAGE);

    expect(injected).toEqual({ block: '', names: [], skills: [] });
    expect(loggedEvent('skills.injection_failed')).toMatchObject({
      level: 'warn',
      error: 'deadlock detected',
    });
  });

  it('injects the matched skill, and logs nothing, when the database is healthy', async () => {
    stubMatchAndContent();
    db.skillUpdateMany.mockResolvedValue({ count: 1 });

    const injected = await injectMatchedSkills(MESSAGE);

    expect(injected.names).toEqual(['Landing page structure']);
    expect(injected.block).toContain('## Active workspace skills');
    expect(injected.block).toContain('Open with a hero, then pricing.');
    expect(db.skillUpdateMany).toHaveBeenCalledTimes(1);
    expect(loggedEvent('skills.injection_failed')).toBeNull();
  });
});
