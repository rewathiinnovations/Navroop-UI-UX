import { describe, expect, it } from 'vitest';
import { updatePlanContentSchema } from '@/lib/projects/schema';

/**
 * The plan edit that silently deleted the contract.
 *
 * `updatePlanContentSchema` validates a PATCH from the plan card and the route writes
 * `parsed.data.content` straight to the row. A bare `z.object` strips what it does not
 * declare, so while the schema had no `sections` key, renaming one page threw away every
 * page's section commitment — and nothing reported it, because stripping is what zod is
 * supposed to do. The schema's own comment claimed it matched `planContentSchema` throughout.
 *
 * These are round-trip tests rather than shape assertions: what matters is that what goes in
 * comes out, since the output is written to the database unexamined.
 */

const base = {
  planId: 'plan_1',
  content: {
    summary: 'A ferry booking site',
    pages: [
      {
        name: 'Home',
        route: '/',
        description: 'Hero, then the operators, then the pitch.',
        sections: ['hero', 'logo-cloud', 'feature-grid'],
      },
      {
        name: 'Pricing',
        route: '/pricing',
        description: 'Three tiers and an FAQ.',
        sections: ['pricing-tiers', 'faq'],
      },
    ],
    keyFeatures: ['Live berth availability'],
  },
};

describe('a user editing the plan does not delete its section contract', () => {
  it('carries sections through unchanged', () => {
    const parsed = updatePlanContentSchema.safeParse(base);

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.content.pages[0].sections).toEqual(['hero', 'logo-cloud', 'feature-grid']);
    expect(parsed.data.content.pages[1].sections).toEqual(['pricing-tiers', 'faq']);
  });

  it('survives the edit the defect was reachable through — renaming a page', () => {
    const renamed = {
      ...base,
      content: {
        ...base.content,
        pages: [{ ...base.content.pages[0], name: 'Welcome' }, base.content.pages[1]],
      },
    };
    const parsed = updatePlanContentSchema.safeParse(renamed);

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.content.pages[0].name).toBe('Welcome');
    expect(parsed.data.content.pages[0].sections).toHaveLength(3);
  });

  it('still accepts a plan written before sections existed', () => {
    const legacy = {
      planId: 'plan_0',
      content: {
        summary: 'An older plan',
        pages: [{ name: 'Home', route: '/', description: 'One page.' }],
        keyFeatures: ['A feature'],
      },
    };
    const parsed = updatePlanContentSchema.safeParse(legacy);

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.content.pages[0].sections).toBeUndefined();
  });

  it('refuses a section list long enough to be a parse bomb', () => {
    const tooMany = {
      ...base,
      content: {
        ...base.content,
        pages: [{ ...base.content.pages[0], sections: Array.from({ length: 13 }, () => 'hero') }],
      },
    };
    expect(updatePlanContentSchema.safeParse(tooMany).success).toBe(false);
  });

  it('refuses an empty section name rather than storing one', () => {
    const blank = {
      ...base,
      content: {
        ...base.content,
        pages: [{ ...base.content.pages[0], sections: ['hero', '  '] }],
      },
    };
    expect(updatePlanContentSchema.safeParse(blank).success).toBe(false);
  });
});
