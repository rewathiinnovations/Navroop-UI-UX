import { describe, it } from 'vitest';
import { runLegacySuite } from '../setup/legacy';
import { PURE_SUITES } from '../setup/suites';

/**
 * Existing assert-style suites (npx tsx) wired into Vitest.
 * They still own their assertions; this file only loads them.
 * The list lives in `tests/setup/suites.ts` so the reachability guard can read it.
 */
describe('legacy suites (no extra DB setup)', () => {
  for (const [name, path] of PURE_SUITES) {
    it(name, async () => {
      await runLegacySuite(path);
    }, 120_000);
  }
});
