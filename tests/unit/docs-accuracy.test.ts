import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Three documentation contracts that drifted silently and cost real money.
 *
 * `docs/e2e-test-and-fix-prompt.md` was 659 lines written to be pasted into an agent verbatim
 * (F-531). It mandated `pnpm exec`, started a dev server on the wrong port, and told the agent to
 * stub ten API routes and visit an admin page that the sandbox removal had deleted — so one paste
 * armed a `node_modules` purge and spent a live-generation budget against endpoints that 404.
 * Prose cannot be typechecked, but the three claims that actually caused harm can be: a command
 * form, an endpoint list, and a freshness marker.
 *
 * `verifyDepsBeforeRun: false` (F-534) and `PREVIEW_PASSWORD` (F-543) are the opposite failure —
 * load-bearing configuration and a whole security control that appeared in no document at all.
 * Both assertions are derived from the code, so they go red when the code changes and the docs do
 * not, which is the only direction that matters.
 */

const ROOT = process.cwd();
const E2E_BRIEF = join(ROOT, 'docs', 'e2e-test-and-fix-prompt.md');

/** Binaries the repo invokes as `node ./node_modules/…`; `pnpm exec <binary>` is the banned form. */
const BINARIES = ['tsc', 'tsx', 'eslint', 'vitest', 'prisma', 'playwright', 'next'];

function apiRouteExists(path: string) {
  // Only the literal head has to resolve: past a dynamic (`[id]`) or wildcard segment nothing can
  // be checked. A Playwright glob keeps its stars (`**/api/create-ai-sandbox**`), so strip those
  // before comparing — otherwise every dead endpoint written as a route pattern escapes the check.
  let dir = join(ROOT, 'app', 'api');
  for (const raw of path.replace(/^\/api\//, '').split('/')) {
    const segment = raw.replaceAll('*', '');
    if (!segment || raw.startsWith('[')) return true;
    const next = join(dir, segment);
    if (!existsSync(next)) return false;
    dir = next;
  }
  return true;
}

describe('docs accuracy', () => {
  it('keeps the e2e brief off `pnpm exec <binary>`', () => {
    // Naming the form to forbid it is fine; issuing it is not. `pnpm exec` runs pnpm's
    // dependency-status check, and the abort an agent shell sees is a `node_modules` purge in a
    // human terminal (AGENTS.md, Verify/release).
    const offenders = readFileSync(E2E_BRIEF, 'utf8')
      .split('\n')
      .filter((line) => BINARIES.some((binary) => line.includes(`pnpm exec ${binary}`)));
    expect(offenders, 'the e2e brief issues a `pnpm exec <binary>` command').toEqual([]);
  });

  it('names only API routes that exist in the e2e brief', () => {
    const text = readFileSync(E2E_BRIEF, 'utf8');
    const named = [...text.matchAll(/\/api\/[a-z0-9\-[\]/*]+/gi)].map((row) => row[0]);
    const missing = [...new Set(named)].filter((path) => !apiRouteExists(path));
    expect(missing, 'the e2e brief drives API routes that do not exist').toEqual([]);
  });

  it('gives the e2e brief an owner and a freshness marker', () => {
    // F-575: it is an executable artefact. Without a date, "is this still true?" has no answer,
    // which is how the 659-line version survived the subsystem it described.
    const text = readFileSync(E2E_BRIEF, 'utf8');
    expect(text).toMatch(/^- Owner: /m);
    expect(text).toMatch(/Verified against code on \*\*\d{4}-\d{2}-\d{2}\*\*/);
  });

  it('documents `verifyDepsBeforeRun` wherever the workspace sets it', () => {
    // Four documents and a git hook describe the purge this setting suppresses. If the setting is
    // present, the document carrying that prose has to say so; otherwise every reader concludes the
    // check still fires (F-534).
    const workspace = readFileSync(join(ROOT, 'pnpm-workspace.yaml'), 'utf8');
    if (!workspace.includes('verifyDepsBeforeRun')) return;
    const agents = readFileSync(join(ROOT, 'AGENTS.md'), 'utf8');
    expect(agents).toContain('verifyDepsBeforeRun');
    expect(agents).toContain('pnpm exec');
  });

  it('documents PREVIEW_PASSWORD while the publish code writes it', () => {
    // An undocumented security control with a two-store invariant: the bcrypt hash on
    // `Deployment.passwordHash` and the plaintext on the Coolify application (F-543). An operator
    // who "cleans up" the env var changes a client preview's access posture.
    const publishDir = join(ROOT, 'lib', 'publish');
    const referenced = readdirSync(publishDir).some((file) =>
      readFileSync(join(publishDir, file), 'utf8').includes('PREVIEW_PASSWORD'),
    );
    if (!referenced) return;
    for (const file of ['AGENTS.md', '.cursor/README.md', 'docs/coolify.md']) {
      expect(
        readFileSync(join(ROOT, file), 'utf8'),
        `${file} does not mention PREVIEW_PASSWORD`,
      ).toContain('PREVIEW_PASSWORD');
    }
  });
});
