import { test } from '@playwright/test';
import { STACK_IDS } from '../lib/stacks';

/**
 * What is left of the per-stack journeys: one skip, named.
 *
 * This file used to hold three `.fixme()` tests, and because
 * `playwright.config.ts` runs it under six project names it reported eighteen
 * results. None of the three took the `page` fixture. Two asserted
 * `expect(stack).toBeTruthy()` on a project name; the third asserted the name was
 * a member of `STACK_IDS` — which is false for three of the six projects, because
 * `STACK_IDS` is `NEXTJS, REACT, STATIC_HTML` and the config also declares ASTRO,
 * VUE and SVELTE. Being `.fixme()` is the only reason that never went red.
 *
 * The free half of the per-stack contract — that the stack a user picks is the
 * stack the created project loads, for every stack in the registry — is now
 * asserted for real, once per `STACK_IDS` entry, in `journeys-workflow.spec.ts`.
 * It lives there because it needs a signed-in session, and these projects have
 * neither `dependencies: ['setup']` nor a storage state.
 *
 * What genuinely remains per stack is the part that costs money: the scaffold
 * `buildRepoFiles` lays down and the layout `stackLayoutMismatchMessage` polices
 * are only observable after a real generation into a real sandbox. There is no
 * honest way to assert that here, so it is one skip that says so rather than six
 * shallow assertions wearing six hats.
 */
test.describe('per-stack plan and build', () => {
  test(`a real build per stack (${STACK_IDS.join(', ')})`, async () => {
    test.skip(
      true,
      'Not implemented: a per-stack build needs a paid AI provider call plus a sandbox VM per stack, which no automated run may spend. The free part of this contract — the picked stack being the stack the project loads — is asserted for every STACK_IDS entry in journeys-workflow.spec.ts.',
    );
  });
});
