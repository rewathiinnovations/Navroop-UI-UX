import '../setup/env';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { testPrismaClient } from '../setup/db';

/**
 * F-748: `updateTemplateRow` was a read-modify-write.
 *
 * It read the row, merged the patch in JS, and then `UPDATE`d all thirteen columns from
 * that merged object. Anything committed between its read and its write was overwritten
 * with the stale value — two admins on `/admin/templates`, or one admin's reorder racing
 * their own content edit, and the second write silently reverted the first. The template
 * prompt is what every project created from that template is generated from, so the lost
 * update is lost work, invisibly. `incrementUsageCount` next door is deliberately atomic
 * and says so in a comment; the edit path was not.
 *
 * The race is made deterministic rather than raced: `$queryRaw` is wrapped so the
 * competing edit commits in the window between the function's `SELECT` and its `UPDATE`.
 * That is exactly the interleaving of two overlapping requests, without the flake.
 */

const real = testPrismaClient();

const TEMPLATE = 'tmpl_partial_update_probe';

/** The competing admin's write, injected once, immediately before the function's UPDATE. */
const race = vi.hoisted(() => ({ beforeUpdate: null as null | (() => Promise<void>) }));

/**
 * The same client the module under test imports, with one hook: the registered competing
 * write commits just before the function's own `UPDATE` statement runs. That is the window
 * two overlapping requests race in, pinned rather than raced — and it does not assume the
 * implementation reads the row first, so the case stays honest for both shapes.
 *
 * `await import` inside the factory is required: `vi.mock` is hoisted above the file's
 * imports, so it cannot close over one.
 */
vi.mock('@/lib/db', async () => {
  const { testPrismaClient: factory } = await import('../setup/db');
  const client = factory();
  const beforeUpdate = async (first: unknown) => {
    const sql = Array.isArray(first) ? first.join(' ') : typeof first === 'string' ? first : '';
    if (!/^\s*UPDATE/i.test(sql) || !race.beforeUpdate) return;
    const competing = race.beforeUpdate;
    race.beforeUpdate = null;
    await competing();
  };
  const wrap = <T extends (...args: never[]) => unknown>(method: T) =>
    (async (...args: unknown[]) => {
      await beforeUpdate(args[0]);
      return (method as (...a: unknown[]) => Promise<unknown>)(...args);
    }) as unknown as T;
  return {
    prisma: Object.assign(client, {
      $queryRaw: wrap(client.$queryRaw.bind(client)),
      $queryRawUnsafe: wrap(client.$queryRawUnsafe.bind(client)),
    }),
  };
});

import { updateTemplateRow } from '@/lib/templates/store';

async function seedTemplate() {
  await real.$executeRaw`DELETE FROM "Template" WHERE id = ${TEMPLATE}`;
  await real.$executeRaw`
    INSERT INTO "Template" (
      id, slug, name, description, category, stack, prompt, "designDirection",
      "isActive", "isBuiltIn", "workspaceId", "usageCount", "sortOrder", "createdAt"
    ) VALUES (
      ${TEMPLATE}, ${'partial-update-probe'}, ${'Probe'}, ${'Probe template'},
      ${'landing'}, 'NEXTJS'::"Stack", ${'ORIGINAL PROMPT'}, ${'minimal'},
      true, false, NULL, 0, 0, NOW()
    )
  `;
}

async function readTemplate() {
  const rows = await real.$queryRaw<Array<{ prompt: string; name: string; sortOrder: number }>>`
    SELECT prompt, name, "sortOrder" FROM "Template" WHERE id = ${TEMPLATE}
  `;
  return rows[0];
}

beforeEach(async () => {
  race.beforeUpdate = null;
  await seedTemplate();
});

afterAll(async () => {
  await real.$executeRaw`DELETE FROM "Template" WHERE id = ${TEMPLATE}`;
  await real.$disconnect();
});

describe('updateTemplateRow writes only the patched columns (F-748)', () => {
  it('does not revert a concurrent edit to a column it was not given', async () => {
    // The other admin's save lands while this request is mid-flight.
    race.beforeUpdate = async () => {
      await real.$executeRaw`
        UPDATE "Template" SET prompt = ${'CONCURRENT PROMPT'} WHERE id = ${TEMPLATE}
      `;
    };

    const updated = await updateTemplateRow(TEMPLATE, { sortOrder: 7 });

    // The injection is consumed by the hook, so this case cannot pass vacuously: had the
    // competing write not landed, `prompt` below would still read 'ORIGINAL PROMPT'.
    expect(race.beforeUpdate).toBeNull();
    // Both edits survive: this request's reorder, and the other admin's prompt.
    expect(updated?.sortOrder).toBe(7);
    const row = await readTemplate();
    expect(row.sortOrder).toBe(7);
    expect(row.prompt).toBe('CONCURRENT PROMPT');
  });

  it('returns the row it wrote, with the patch applied', async () => {
    const updated = await updateTemplateRow(TEMPLATE, {
      name: 'Renamed probe',
      prompt: 'NEW PROMPT',
      isActive: false,
    });

    expect(updated?.name).toBe('Renamed probe');
    expect(updated?.prompt).toBe('NEW PROMPT');
    expect(updated?.isActive).toBe(false);
    // Untouched columns keep their stored values.
    expect(updated?.slug).toBe('partial-update-probe');
    expect(updated?.category).toBe('landing');
  });

  it('is a no-op that still reports the row when the patch is empty', async () => {
    const updated = await updateTemplateRow(TEMPLATE, {});
    expect(updated?.prompt).toBe('ORIGINAL PROMPT');
  });

  it('answers null for a template that does not exist', async () => {
    expect(await updateTemplateRow('tmpl_does_not_exist', { sortOrder: 1 })).toBeNull();
  });
});
