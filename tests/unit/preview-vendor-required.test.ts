import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error -- plain ESM build script, no type declarations
import { copyPreviewVendor, main } from '../../scripts/copy-preview-vendor.mjs';

/**
 * `esbuild.wasm` is 12 MB and deliberately not committed (`.gitignore:94`), so
 * the only thing that puts it under `public/preview-vendor` is this script,
 * chained ahead of `next build` with `&&` (`package.json:9`). It used to warn
 * and `process.exit(0)` when the source was missing, so a pruned or
 * `--ignore-scripts` install produced a green build whose preview pane could
 * never compile anything — the only way a project renders now (F-710).
 *
 * A temp root is used throughout: the real `public/preview-vendor` must not be
 * touched, and `tests/setup/repo-write-guard.global.ts` fails the run if it is.
 */
const roots: string[] = [];

function tempRoot(withWasm: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'preview-vendor-'));
  roots.push(root);
  if (withWasm) {
    const dir = join(root, 'node_modules', 'esbuild-wasm');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'esbuild.wasm'), Buffer.from([0x00, 0x61, 0x73, 0x6d]));
  }
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('copy-preview-vendor', () => {
  it('refuses to succeed when esbuild.wasm is missing', () => {
    const root = tempRoot(false);

    expect(() => copyPreviewVendor(root)).toThrowError(/esbuild\.wasm/);
    // The message has to name the file and where it comes from, because the
    // operator reading it is looking at an otherwise-clean build log.
    expect(() => copyPreviewVendor(root)).toThrowError(/esbuild-wasm/);
    expect(() => copyPreviewVendor(root)).toThrowError(/install/i);
  });

  it('exits non-zero so `next build` cannot run behind it', () => {
    const errors: unknown[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.join(' '));
    });

    expect(main(tempRoot(false))).toBe(1);
    expect(String(errors[0])).toContain('esbuild.wasm');
  });

  it('copies the binary and reports success when it is installed', () => {
    const root = tempRoot(true);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    expect(main(root)).toBe(0);
    expect(existsSync(join(root, 'public', 'preview-vendor', 'esbuild.wasm'))).toBe(true);
  });
});
