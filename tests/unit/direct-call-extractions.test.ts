/**
 * The generation and apply routes used to reach these functions over HTTP and
 * dropped every failure into an `if (response.ok)` else branch. They are direct
 * calls now, so each one has to report failure as a typed result the caller can
 * act on. These tests pin the failure shapes.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { analyzeEditIntent } from '../../lib/generation/analyze-edit-intent';
import {
  getSelfIdentity,
  resetSelfIdentityCache,
  SELF_UUID_NOT_CONFIGURED,
} from '../../lib/runtime/self';

type Mutable = Record<string, unknown>;

const globals = globalThis as unknown as Mutable;

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  delete globals.activeSandbox;
  delete globals.activeSandboxProvider;
  delete globals.sandboxData;
  delete globals.lastViteRestartTime;
  delete globals.viteRestartInProgress;
});

afterEach(() => {
  vi.restoreAllMocks();
  resetSelfIdentityCache();
});

describe('analyzeEditIntent', () => {
  it('reports a missing prompt or manifest instead of calling the model', async () => {
    expect(await analyzeEditIntent({ prompt: '', manifest: { files: {} }, userId: null })).toEqual({
      ok: false,
      status: 400,
      error: 'prompt and manifest are required',
    });
    expect(
      await analyzeEditIntent({ prompt: 'make it blue', manifest: null, userId: null }),
    ).toEqual({
      ok: false,
      status: 400,
      error: 'prompt and manifest are required',
    });
  });

  it('reports an empty manifest rather than planning against nothing', async () => {
    const result = await analyzeEditIntent({
      prompt: 'make the header blue',
      // Numeric-suffixed paths are parser artefacts, not files.
      manifest: { files: { 'src/App/1': {} } },
      userId: null,
    });
    expect(result).toEqual({ ok: false, status: 400, error: 'No valid files found in manifest' });
  });
});

describe('self identity', () => {
  it('treats a blank COOLIFY_APP_UUID as not configured', () => {
    expect(
      getSelfIdentity({ COOLIFY_APP_UUID: '   ' } as NodeJS.ProcessEnv).coolifyAppUuid,
    ).toBeNull();
    expect(getSelfIdentity({} as NodeJS.ProcessEnv).coolifyAppUuid).toBeNull();
  });

  it('trims a configured uuid and reports the release', () => {
    const identity = getSelfIdentity({
      COOLIFY_APP_UUID: ' abc-123 ',
      GIT_SHA: 'deadbeef',
      NODE_ENV: 'production',
    } as NodeJS.ProcessEnv);
    expect(identity.coolifyAppUuid).toBe('abc-123');
    expect(identity.gitSha).toBe('deadbeef');
    expect(identity.environment).toBe('production');
    expect(identity.instanceId).toBeTruthy();
  });

  it('gives restart and rollback the same not-configured message', () => {
    expect(SELF_UUID_NOT_CONFIGURED).toContain('COOLIFY_APP_UUID');
    expect(SELF_UUID_NOT_CONFIGURED).toContain('not configured');
  });
});

const GENERATE_STREAM = path.join(process.cwd(), 'app/api/generate-ai-code-stream/route.ts');

function matchingBrace(source: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < source.length; i++) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function catchForCall(source: string, callName: string): string[] {
  const needle = `await ${callName}(`;
  const blocks: string[] = [];
  let from = 0;
  while (from < source.length) {
    const callIdx = source.indexOf(needle, from);
    if (callIdx < 0) break;
    let lastTry: number | null = null;
    let search = 0;
    while (search < callIdx) {
      const tryIdx = source.indexOf('try {', search);
      if (tryIdx < 0 || tryIdx > callIdx) break;
      const open = source.indexOf('{', tryIdx);
      const close = matchingBrace(source, open);
      if (close > callIdx) lastTry = close;
      search = tryIdx + 4;
    }
    if (lastTry === null) {
      throw new Error(`no enclosing try for ${callName} at ${callIdx}`);
    }
    const after = source.slice(lastTry + 1);
    const catchOpenRel = after.search(/catch\s*\([^)]*\)\s*\{/);
    if (catchOpenRel < 0) {
      throw new Error(`no catch after try for ${callName} at ${callIdx}`);
    }
    const catchOpen = lastTry + 1 + after.indexOf('{', catchOpenRel);
    const catchClose = matchingBrace(source, catchOpen);
    blocks.push(source.slice(catchOpen, catchClose + 1));
    from = callIdx + needle.length;
  }
  return blocks;
}

describe('generate-ai-code-stream unexpected-throw job steps', () => {
  const source = readFileSync(GENERATE_STREAM, 'utf8');

  // The read-sandbox-files step is gone with the sandbox: current files come
  // from the project row, and a failure there fails the request rather than
  // being recorded as a skipped step.
  it('records analyze-edit-intent when analyzeEditIntent throws', () => {
    const catches = catchForCall(source, 'analyzeEditIntent');
    expect(catches.length).toBeGreaterThanOrEqual(1);
    for (const block of catches) {
      expect(block).toMatch(/recordJobStepFailure\(/);
      expect(block).toMatch(/key:\s*'analyze-edit-intent'/);
    }
  });
});
