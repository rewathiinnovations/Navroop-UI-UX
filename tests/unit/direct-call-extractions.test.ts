/**
 * The generation and apply routes used to reach these functions over HTTP and
 * dropped every failure into an `if (response.ok)` else branch. They are direct
 * calls now, so each one has to report failure as a typed result the caller can
 * act on. These tests pin the failure shapes.
 */
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
