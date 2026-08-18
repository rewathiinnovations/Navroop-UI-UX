import '../setup/env';
import { describe, it } from 'vitest';
import { runLegacySuite } from '../setup/legacy';
import { DB_SUITES } from '../setup/suites';

describe('legacy suites (TEST_DATABASE_URL)', () => {
  for (const [name, path] of DB_SUITES) {
    it(name, async () => {
      await runLegacySuite(path);
    }, 180_000);
  }
});
