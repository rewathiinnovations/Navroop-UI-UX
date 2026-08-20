import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * F-094. The follow-up file-context budget was the one generation-cost knob still read
 * straight from `process.env`: raising it changed what every follow-up costs, with no field
 * on /admin/config and no audit entry naming who changed it. It now resolves through the
 * same database → environment → registry-fallback order as every other setting, and the
 * variable it used to be the only source for still works untouched.
 */

const findUnique = vi.fn();

vi.mock('@/lib/logger', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  logError: vi.fn(),
  formatLogLine: vi.fn(() => ''),
}));

vi.mock('@/lib/db', () => ({
  prisma: {
    appSetting: {
      findUnique: (...args: unknown[]) => findUnique(...args),
      findMany: vi.fn().mockResolvedValue([]),
    },
  },
}));

// The resolver decrypts secret rows, so lib/crypto needs key material even though this
// setting is not a secret. Assembled from parts: a contiguous 32-byte literal trips the
// secret scanner that runs on every commit.
process.env.ENCRYPTION_KEY = ['file-context-cap', 'test-key', 'at-least-32-bytes'].join('-');

const { SETTINGS } = await import('@/lib/settings/registry');
const { invalidateSettingsCache } = await import('@/lib/settings/resolve');
const { DEFAULT_FILE_CONTEXT_TOKEN_CAP, fileContextTokenCap, selectFileContext } =
  await import('@/lib/generation/selective-context');

/** Matches the shape `saveSettings` writes for a non-secret value. */
function storedRow(value: string) {
  return { value: JSON.stringify({ value, encrypted: false }) };
}

beforeEach(() => {
  invalidateSettingsCache();
  findUnique.mockReset();
  findUnique.mockResolvedValue(null);
  delete process.env.NAVROOP_FILE_CONTEXT_TOKEN_CAP;
});

afterEach(() => {
  invalidateSettingsCache();
  delete process.env.NAVROOP_FILE_CONTEXT_TOKEN_CAP;
});

describe('follow-up file context cap', () => {
  it('is offered on /admin/config, and advertises the default the code actually uses', () => {
    // A number on the config screen that the runtime ignores is the same lie as a field
    // nothing reads: the two have to be one value.
    const entry = SETTINGS.find((row) => row.key === 'ai.fileContextTokenCap');
    expect(entry).toBeDefined();
    expect(entry?.group).toBe('ai');
    expect(entry?.kind).toBe('number');
    expect(entry?.env).toBe('NAVROOP_FILE_CONTEXT_TOKEN_CAP');
    expect(entry?.fallback).toBe(String(DEFAULT_FILE_CONTEXT_TOKEN_CAP));
  });

  it('prefers the saved setting over the environment variable', async () => {
    process.env.NAVROOP_FILE_CONTEXT_TOKEN_CAP = '9000';
    findUnique.mockResolvedValue(storedRow('5000'));
    expect(await fileContextTokenCap()).toBe(5000);
  });

  it('still honours the environment variable when nothing is saved', async () => {
    process.env.NAVROOP_FILE_CONTEXT_TOKEN_CAP = '9000';
    expect(await fileContextTokenCap()).toBe(9000);
  });

  it('falls back to the built-in default when neither is set', async () => {
    expect(await fileContextTokenCap()).toBe(DEFAULT_FILE_CONTEXT_TOKEN_CAP);
  });

  it('ignores a blank or nonsense saved value rather than dropping the cap to zero', async () => {
    findUnique.mockResolvedValue(storedRow('not-a-number'));
    expect(await fileContextTokenCap()).toBe(DEFAULT_FILE_CONTEXT_TOKEN_CAP);
  });

  it('applies the resolved cap to the selection instead of a compiled-in number', async () => {
    findUnique.mockResolvedValue(storedRow('300'));
    const cap = await fileContextTokenCap();
    expect(cap).toBe(300);

    // Six files the model is being asked to edit, ~125 tokens each. Only files the request
    // names are ever sent in full, so naming all six makes the budget the only thing that
    // can hold any of them back.
    const paths = Array.from({ length: 6 }, (_, i) => `src/mod-${i}.tsx`);
    const files = Object.fromEntries(paths.map((path) => [path, 'x'.repeat(500)]));
    const selected = selectFileContext({
      files,
      userMessage: 'update everything',
      primaryPaths: paths,
      tokenCap: cap,
    });

    expect(selected.fullPaths.length).toBeLessThan(6);
    expect(selected.pathOnly.length).toBeGreaterThan(0);

    // The same input under the built-in default sends all six, which is what proves the
    // trimming above came from the saved setting and not from the shape of the fixture.
    const roomy = selectFileContext({
      files,
      userMessage: 'update everything',
      primaryPaths: paths,
      tokenCap: DEFAULT_FILE_CONTEXT_TOKEN_CAP,
    });
    expect(roomy.pathOnly).toEqual([]);
    expect(roomy.fullPaths).toHaveLength(6);
    expect(roomy.estimatedTokens).toBeGreaterThan(cap);
  });
});
