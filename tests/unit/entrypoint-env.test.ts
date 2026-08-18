import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('production entrypoint env', () => {
  it('fails closed on a missing or short ENCRYPTION_KEY with a readable message', () => {
    const source = readFileSync(join(process.cwd(), 'docker-entrypoint.mjs'), 'utf8');
    expect(source).toMatch(/ENCRYPTION_KEY is missing \(must be at least 32 bytes\)/);
    expect(source).toMatch(/ENCRYPTION_KEY is too short \(must be at least 32 bytes\)/);
    expect(source).toMatch(/APP_URL must be set/);
    expect(source).toMatch(/scripts\/reconcile-jobs\.ts/);
  });
});
