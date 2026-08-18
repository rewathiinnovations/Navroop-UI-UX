import { expect, test } from '@playwright/test';
import { STACK_IDS } from '../lib/stacks';

/**
 * Journeys 1–3 × all six stacks. The Playwright project name is the stack.
 *
 * All three are `.fixme()`. Not one of them takes the `page` fixture: they read
 * the project name out of `playwright.config.ts` and assert it is a non-empty
 * member of `STACK_IDS`. Across six projects that is eighteen results, and the
 * six-way `stacks` matrix in CI installs Chromium in each job to confirm the
 * config file has not been edited. `tests/unit` already pins `STACK_IDS`.
 */
test.describe('stack journeys 1–3', () => {
  // Should: not exist as a test. Project-name-to-stack wiring belongs in a unit
  // test over `playwright.config.ts`, not in a browser job.
  test.fixme('names the stack on failure', async ({}, testInfo) => {
    const stack = testInfo.project.name;
    expect(STACK_IDS, `unknown stack project ${stack}`).toContain(stack);
    testInfo.annotations.push({ type: 'stack', description: stack });
    testInfo.annotations.push({ type: 'status', description: 'scaffolded' });
  });

  // Should: signed in, create a project with this stack selected and assert the
  // generated tree matches the stack (e.g. astro.config for ASTRO, index.html for
  // STATIC_HTML) and that the preview renders. Needs `page` and real generation.
  test.fixme('journey 2 create project for this stack (scaffolded)', async ({}, testInfo) => {
    const stack = testInfo.project.name;
    expect(stack, `stack journey failed for ${stack}`).toBeTruthy();
  });

  // Should: signed in, run a plan then a build for this stack and assert the plan
  // steps render and the build reaches a finished job. Needs `page`.
  test.fixme('journey 3 plan/build for this stack (scaffolded)', async ({}, testInfo) => {
    const stack = testInfo.project.name;
    expect(stack, `stack journey failed for ${stack}`).toBeTruthy();
  });
});
