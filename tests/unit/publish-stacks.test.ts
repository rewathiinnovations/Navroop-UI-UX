import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { STACK_IDS, getStack } from '../../lib/stacks';

/**
 * The Coolify application is created from the stack row, so a silent change to a
 * build command changes what every publish of that stack runs on the server.
 *
 * This file used to assert `stack.buildCommand === null || typeof stack.buildCommand === 'string'`,
 * which restates the declared type and passes for every possible value — including a
 * command edited to the wrong thing. It also never checked that publish reads the row
 * at all, while claiming to (F-610).
 */

const EXECUTE = fileURLToPath(new URL('../../lib/publish/execute.ts', import.meta.url));

/** The exact payload each stack hands Coolify. A change here is a deploy-behaviour change. */
const EXPECTED = {
  NEXTJS: {
    deployType: 'node',
    buildCommand: 'npm run build',
    startCommand: 'npm start',
  },
  REACT: {
    deployType: 'static',
    buildCommand: 'npm run build',
    startCommand: null,
  },
  STATIC_HTML: {
    deployType: 'static',
    buildCommand: null,
    startCommand: null,
  },
} as const;

describe('publish stack build config', () => {
  it('pins the build, start and deploy type of every stack', () => {
    // Exhaustive both ways: a new stack with no expectation fails here rather than
    // shipping an unreviewed build command.
    expect([...STACK_IDS].sort()).toEqual(Object.keys(EXPECTED).sort());
    for (const id of STACK_IDS) {
      const stack = getStack(id);
      const expected = EXPECTED[id];
      expect(stack.id).toBe(id);
      expect(stack.deployType).toBe(expected.deployType);
      expect(stack.buildCommand).toBe(expected.buildCommand);
      expect(stack.startCommand).toBe(expected.startCommand);
    }
  });

  it('a node stack always has something to start and a static stack never does', () => {
    for (const id of STACK_IDS) {
      const stack = getStack(id);
      if (stack.deployType === 'node') {
        expect(stack.startCommand, `${id} is node and must have a start command`).toBeTruthy();
      } else {
        expect(stack.startCommand, `${id} is static and must not have one`).toBeNull();
      }
    }
  });

  it('publish hands the stack row to Coolify rather than composing its own', () => {
    const source = readFileSync(EXECUTE, 'utf8');
    const anchor = source.indexOf('deps.createApp(auth, {');
    expect(anchor, 'the createApp call moved — re-anchor this test').toBeGreaterThan(-1);
    const payload = source.slice(anchor, source.indexOf('})', anchor));
    // Positive first: an empty window would satisfy the negatives below.
    expect(payload).toContain('deployType: stack.deployType');
    expect(payload).toContain('buildCommand: stack.buildCommand');
    expect(payload).toContain('startCommand: stack.startCommand');
    expect(payload).toContain('outputDir: stack.outputDir');
  });
});
