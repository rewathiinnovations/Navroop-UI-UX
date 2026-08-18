import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('production image', () => {
  it('stays multi-stage, non-root, and health-checks /api/health', () => {
    const docker = readFileSync(join(process.cwd(), 'Dockerfile'), 'utf8');
    expect(docker).toMatch(/FROM node:20/);
    expect(docker).toMatch(/USER nextjs/);
    expect(docker).toMatch(/HEALTHCHECK/);
    expect(docker).toMatch(/\/api\/health/);
    expect(docker).toMatch(/postgresql-client/);
    expect(docker).toMatch(/docker-entrypoint\.mjs/);
    expect(docker).toMatch(/mkdir -p \/data\/config \/data\/cache \/data\/tmp/);
    expect(docker).toMatch(/chown -R nextjs:nodejs \/data/);
    expect(docker).toMatch(/DATA_DIR=\/data/);
  });
});
