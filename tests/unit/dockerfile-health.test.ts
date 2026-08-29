import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('production image', () => {
  it('stays multi-stage, non-root, and health-checks /api/health', () => {
    const docker = readFileSync(join(process.cwd(), 'Dockerfile'), 'utf8');
    // 22 is the floor, not a ceiling pin: the declared pnpm (11.21) needs Node >= 22.13
    // (`node:sqlite`), and CI runs the gate on Node 22 — a node:20 image crashed every
    // pnpm invocation at startup (deploy 2026-08-29).
    expect(docker).toMatch(/FROM node:22/);
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
