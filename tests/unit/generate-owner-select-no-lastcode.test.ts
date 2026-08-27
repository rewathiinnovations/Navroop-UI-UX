import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const routePath = path.join(
  fileURLToPath(new URL('../../', import.meta.url)),
  'app/api/generate-ai-code-stream/route.ts',
);
// Newline-normalised for the same reason `tests/unit/generate-project-required.test.ts`
// does it: core.autocrlf=true gives this file CRLF in a fresh Windows checkout.
const source = readFileSync(routePath, 'utf8').replace(/\r\n/g, '\n');

/**
 * Fix round 2, defect B. The ownership lookup that gates every send selected
 * `lastCode` alongside `id`, `ownerId` and `phase`, and the only thing the handler
 * ever did with it was `Boolean(ownedProject.lastCode)`. `Project.lastCode` is the
 * whole `<file …>` serialisation of the site, bounded only by `LAST_CODE_MAX_BYTES`
 * (4 MB), so every message in an established project — a one-line follow-up edit
 * included — pulled the site body out of Postgres to answer a yes/no, ahead of the
 * rate limit, the credit check and any provider call.
 *
 * The route is driven end to end by other suites; this one holds the query shape,
 * which is the whole of the defect and is invisible in a response body.
 */
describe('the ownership lookup does not read the site body to answer a boolean', () => {
  const selectAt = source.indexOf('const ownedProject = await prisma.project.findFirst({');
  const ownershipQuery = source.slice(selectAt, selectAt + 300);

  it('finds the ownership lookup', () => {
    expect(selectAt).toBeGreaterThan(0);
  });

  it('selects only the columns the handler reads', () => {
    expect(ownershipQuery).toMatch(/select: \{ id: true, ownerId: true, phase: true \}/);
    expect(ownershipQuery).not.toMatch(/lastCode/);
  });

  it('no longer coerces the body to a boolean', () => {
    expect(source).not.toMatch(/Boolean\(ownedProject\.lastCode\)/);
    expect(source).not.toMatch(/ownedProject\.lastCode/);
  });

  it('asks the database whether a body exists instead of fetching one', () => {
    expect(source).toMatch(/await prisma\.project\.count\(\{/);
    // Exactly what `Boolean(lastCode)` meant: present and non-empty.
    expect(source).toMatch(/AND: \[\{ NOT: \{ lastCode: null \} \}, \{ NOT: \{ lastCode: '' \} \}\]/);
  });

  it('does not ask at all when the client already declared an edit', () => {
    // The answer is used for one thing — forcing `isEdit` true — so on the send this
    // defect is about (a follow-up edit, where the client already says isEdit) the
    // handler must issue no extra query whatsoever.
    expect(source).toMatch(
      /if \(!isEdit\) \{\n\s*const serverHasSite =\n\s*ownedProject\.phase === 'COMPLETE' \|\|\n\s*\(await prisma\.project\.count\(\{/,
    );
  });

  it('asks only after every cheap refusal has had its chance', () => {
    // `isEdit` is first read by `createOrReuseJob`, so the question can wait: a caller
    // the rate limiter, the credit check or the lock is about to turn away must not pay
    // for a query first. Left beside the ownership check it also broke
    // `tests/unit/project-write-authz.test.ts`, whose 429 case never reaches a database.
    const countAt = source.indexOf('await prisma.project.count({');
    expect(countAt).toBeGreaterThan(source.indexOf('allowGenerationSubmit(sessionUser.id)'));
    expect(countAt).toBeGreaterThan(source.indexOf('await checkCredits('));
    expect(countAt).toBeGreaterThan(source.indexOf('await holdProjectLock('));
    expect(countAt).toBeLessThan(source.indexOf('await createOrReuseJob({'));
  });

  it('still overrides a stale client isEdit from the server-side evidence', () => {
    // The override itself is the F-665-pattern guard the defect must not weaken:
    // phase alone still answers for a COMPLETE project, and the log still fires.
    expect(source).toMatch(/ownedProject\.phase === 'COMPLETE'/);
    expect(source).toMatch(/generation\.isEdit_override/);
    expect(source).toMatch(/\n\s*isEdit = true;/);
  });
});
