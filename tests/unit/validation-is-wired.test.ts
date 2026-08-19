import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The check that was supposed to catch a broken build had *no caller*. That is
 * how `No matching export in "vfs:lib/data.ts" for import "site"` reached a
 * user's browser while chat reported success, and it is why unit tests over the
 * validator are not enough on their own: they all passed while nothing ran it.
 *
 * These assertions are the tripwire. Following the repo's existing route
 * source-scan tests (tests/unit/generate-provider-preflight.test.ts,
 * tests/unit/edit-context-from-project.test.ts), they fail the moment validation
 * goes callerless again, or the sandbox-shaped skip returns.
 */

function source(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), 'utf8');
}

const ROUTE = 'app/api/generate-ai-code-stream/route.ts';

describe('generated code is validated before the user is told it worked', () => {
  it('the generate route calls the validator', () => {
    const route = source(ROUTE);
    expect(route, `${ROUTE} does not import the validator`).toContain(
      '@/lib/validation/run-build-validation',
    );
    expect(route, `${ROUTE} imports the validator but never calls it`).toMatch(
      /runBuildValidation\(\s*\{/,
    );
  });

  it('the route scopes the check to the files this run generated', () => {
    // Without `changedPaths` a pre-existing problem in an untouched file fails a
    // build the model did not break.
    expect(source(ROUTE)).toContain('changedPaths');
  });

  it('the route hands the retry payload to the client', () => {
    // GenerationWorkspace drives the fix loop off `buildFix` on the complete
    // frame; the server owns the policy, the client only carries the counter.
    const route = source(ROUTE);
    const completeFrame = route.slice(route.indexOf("type: 'complete'"));
    expect(completeFrame, 'the complete frame carries no buildFix payload').toContain('buildFix');
  });
});

describe('no check can skip for want of infrastructure', () => {
  it('the bundle check has no sandbox path left to skip on', () => {
    // It used to shell a build command into a sandbox VM and skip when there was
    // none; migration 20260819010000_drop_sandbox_columns then removed sandboxes,
    // so it skipped every run while the docs described a working loop.
    const check = source('lib/validation/build-check.ts');
    expect(check).not.toContain('SandboxRunner');
    expect(check).not.toMatch(/no-sandbox|sandbox\?\.|runInSandbox/);
    expect(check).toContain('buildStaticSite');
  });

  it('the only skip reasons are honest ones', () => {
    const check = source('lib/validation/build-check.ts');
    const reasons = [...check.matchAll(/skipReason\?*:\s*'([a-z-]+)'/g)].map((match) => match[1]);
    // `checker-unavailable` is honest only because runBuildValidation reports it
    // in chat and on the job — see its own test. A silent third reason would be
    // the sandbox skip all over again.
    expect(new Set(reasons)).toEqual(
      new Set(['no-build-command', 'no-files', 'checker-unavailable']),
    );
    expect(source('lib/validation/run-build-validation.ts')).toContain('checker-unavailable');
  });
  it('the admin toggle governs the fix, not the check', () => {
    // A toggle that switched off *checking* would be the same silent hole with a
    // different cause, so the failure is still reported when it is off.
    const orchestrator = source('lib/validation/run-build-validation.ts');
    const settingRead = orchestrator.indexOf('getBuildAutoFixEnabled');
    const staticCheck = orchestrator.indexOf('checkGeneratedImports');
    expect(settingRead).toBeGreaterThan(-1);
    expect(staticCheck).toBeGreaterThan(-1);
    // Read as a value passed to the policy, never used to return early.
    expect(orchestrator).toContain('enabled,');
    expect(orchestrator).not.toMatch(/if \(!\(await getBuildAutoFixEnabled\(\)\)\)/);
  });
});
