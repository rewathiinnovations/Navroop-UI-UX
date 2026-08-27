import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const routePath = path.join(
  fileURLToPath(new URL('../../', import.meta.url)),
  'app/api/generate-ai-code-stream/route.ts',
);

/**
 * Comments stripped, and CRLF normalised for the reason
 * `tests/unit/generate-owner-select-no-lastcode.test.ts` gives (core.autocrlf=true
 * hands a fresh Windows checkout CRLF). The stripping is not cosmetic: the first
 * assertion in this file used to be `/lastCode.*phase/`, and after the count refactor
 * the only thing left matching it was the route's own prose — "the server always has
 * the truth — lastCode and phase". A source-text guard a comment can satisfy passes
 * forever, which is the failure mode this repo has already paid for elsewhere. Only
 * whole-line `//` comments are cut, so a `https://` inside a string literal survives.
 */
const routeCode = readFileSync(routePath, 'utf8')
  .replace(/\r\n/g, '\n')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '');

/**
 * The server overrides the client's isEdit flag when it has evidence of an existing
 * site (lastCode or phase COMPLETE). The client can get this wrong when the file map
 * hasn't loaded yet, the fetch 403'd, or the browser is stale — causing the model
 * to replace an existing site with a brand-new one.
 */
describe('server-side isEdit override', () => {
  const overrideAt = routeCode.indexOf('if (!isEdit) {');
  // Scoped rather than file-wide, so no assertion below can be satisfied by an
  // unrelated `isEdit = true` somewhere else in a 2000-line handler.
  const overrideBlock = routeCode.slice(overrideAt, overrideAt + 900);

  it('guards the send on the server-side evidence at all', () => {
    expect(overrideAt).toBeGreaterThan(0);
  });

  it('computes serverHasSite from phase and an existence check on lastCode', () => {
    // `Boolean(ownedProject.lastCode)` was the original spelling and it pulled the
    // whole `<file …>` serialisation — up to LAST_CODE_MAX_BYTES, 4 MB — out of
    // Postgres on every send to answer a yes/no. `count` with `NOT null` plus
    // `NOT ''` is exactly what it meant, without transferring a body. Both disjuncts
    // are asserted because dropping either one is what reopens F-665.
    expect(overrideBlock).toMatch(
      /const serverHasSite =\s*ownedProject\.phase === 'COMPLETE' \|\|\s*\(await prisma\.project\.count\(\{/,
    );
    expect(overrideBlock).toMatch(
      /AND: \[\{ NOT: \{ lastCode: null \} \}, \{ NOT: \{ lastCode: '' \} \}\]/,
    );
    expect(overrideBlock).toMatch(/\}\)\) > 0;/);
  });

  it('overrides isEdit to true only when the server has a site and the client said false', () => {
    // The two conditions are no longer one expression: `!isEdit` was hoisted to an
    // outer guard so the count is only paid on a send it can change the outcome of.
    // The conjunction still holds — one condition per `if`, in this order.
    const evidence = overrideBlock.indexOf('const serverHasSite =');
    const acts = overrideBlock.indexOf('if (serverHasSite) {');
    const forces = overrideBlock.indexOf('isEdit = true;');

    expect(evidence).toBeGreaterThan(0);
    expect(acts).toBeGreaterThan(evidence);
    expect(forces).toBeGreaterThan(acts);
  });

  it('logs the override for observability', () => {
    expect(overrideBlock).toMatch(/generation\.isEdit_override/);
  });

  it('renames the client-supplied flag to clientIsEdit to prevent accidental reuse', () => {
    // The client's isEdit is destructured as clientIsEdit; the local isEdit
    // is a let that the server can override. This prevents the old code path
    // from reading the client's original value after the override.
    expect(routeCode).toMatch(/isEdit:\s*clientIsEdit/);
  });
});
