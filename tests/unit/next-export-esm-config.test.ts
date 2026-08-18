import { describe, expect, it } from 'vitest';
import {
  esmExportWrapper,
  nextConfigIsEsm,
  originalConfigSidecarPath,
  withTemporaryNextExport,
  wrapNextConfigForExport,
} from '@/lib/preview/next-export';

/**
 * The static preview builds with `output: 'export'` forced on, by editing the sandbox's
 * next.config for the duration of the build and restoring it afterwards.
 *
 * That edit appended `module.exports = ...` unconditionally. The NEXTJS scaffold writes
 * `next.config.mjs` (`lib/stacks/templates/nextjs.ts`), which is an ES module — `module` is
 * not defined there. Every static preview build therefore died with:
 *
 *   ReferenceError: module is not defined in ES module scope
 *       at file:///home/user/app/next.config.mjs:9:1
 *
 * and the project fell back to LIVE_SANDBOX with `previewUrl: null`. Observed live on
 * 2026-08-18 against a generation that had otherwise completely succeeded.
 */

/** Records what the build actually saw on disk, which is the only thing that matters. */
function fakeIo(files: Record<string, string>) {
  const removed: string[] = [];
  const io = {
    readFile: async (path: string) => files[path] ?? '',
    writeFile: async (path: string, content: string) => {
      files[path] = content;
    },
    removeFile: async (path: string) => {
      removed.push(path);
      delete files[path];
    },
  };
  return { io, files, removed };
}

const ESM_CONFIG = `/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
};

export default nextConfig;
`;

const CJS_CONFIG = `/** @type {import('next').NextConfig} */
const nextConfig = { reactStrictMode: true };

module.exports = nextConfig;
`;

describe('the module system of the config is respected', () => {
  it('recognises an ESM config by its own contents', () => {
    expect(nextConfigIsEsm(ESM_CONFIG)).toBe(true);
    expect(nextConfigIsEsm("import path from 'node:path';\nmodule.exports = {};")).toBe(true);
    expect(nextConfigIsEsm(CJS_CONFIG)).toBe(false);
  });

  it('never appends CommonJS to an ES module', async () => {
    const { io, files } = fakeIo({ 'next.config.mjs': ESM_CONFIG });
    let duringBuild = '';
    await withTemporaryNextExport(io, 'next.config.mjs', async () => {
      duringBuild = files['next.config.mjs'];
    });

    // The exact line that threw at next.config.mjs:9:1.
    expect(duringBuild).not.toContain('module.exports');
    expect(duringBuild).toContain("output: 'export'");
    expect(duringBuild).toContain('import navroopBaseConfig');
  });

  it('parks the original beside the wrapper and imports it back', async () => {
    const { io, files } = fakeIo({ 'next.config.mjs': ESM_CONFIG });
    let sidecarDuringBuild = '';
    await withTemporaryNextExport(io, 'next.config.mjs', async () => {
      sidecarDuringBuild = files['next.config.navroop-original.mjs'];
    });

    // The wrapper is only correct if the file it imports really holds the user's config.
    expect(sidecarDuringBuild).toBe(ESM_CONFIG);
    expect(esmExportWrapper('next.config.navroop-original.mjs')).toContain(
      "import navroopBaseConfig from './next.config.navroop-original.mjs'",
    );
  });

  it('keeps the sidecar extension, so the loader treats both files the same', () => {
    expect(originalConfigSidecarPath('next.config.mjs')).toBe('next.config.navroop-original.mjs');
    expect(originalConfigSidecarPath('next.config.ts')).toBe('next.config.navroop-original.ts');
    expect(originalConfigSidecarPath('next.config.js')).toBe('next.config.navroop-original.js');
  });

  it('restores the config byte for byte and leaves no sidecar behind', async () => {
    const { io, files, removed } = fakeIo({ 'next.config.mjs': ESM_CONFIG });
    await withTemporaryNextExport(io, 'next.config.mjs', async () => undefined);

    // A sidecar that survives lands in the next checkpoint as user source.
    expect(files['next.config.mjs']).toBe(ESM_CONFIG);
    expect(removed).toEqual(['next.config.navroop-original.mjs']);
    expect(files['next.config.navroop-original.mjs']).toBeUndefined();
  });

  it('restores even when the build throws', async () => {
    const { io, files, removed } = fakeIo({ 'next.config.mjs': ESM_CONFIG });
    await expect(
      withTemporaryNextExport(io, 'next.config.mjs', async () => {
        throw new Error('next build failed');
      }),
    ).rejects.toThrow('next build failed');

    expect(files['next.config.mjs']).toBe(ESM_CONFIG);
    expect(removed).toEqual(['next.config.navroop-original.mjs']);
  });
});

describe('the CommonJS path is unchanged', () => {
  it('still appends the merge line', async () => {
    const { io, files } = fakeIo({ 'next.config.js': CJS_CONFIG });
    let duringBuild = '';
    await withTemporaryNextExport(io, 'next.config.js', async () => {
      duringBuild = files['next.config.js'];
    });

    expect(duringBuild).toContain('module.exports = Object.assign(');
    expect(duringBuild).toContain("output: 'export'");
    expect(files['next.config.js']).toBe(CJS_CONFIG);
    // No sidecar is needed when the file can simply be appended to.
    expect(files['next.config.navroop-original.js']).toBeUndefined();
  });

  it('leaves a config that already exports completely alone', async () => {
    const already = "export default { output: 'export' };\n";
    const { io, files } = fakeIo({ 'next.config.mjs': already });
    let duringBuild = '';
    await withTemporaryNextExport(io, 'next.config.mjs', async () => {
      duringBuild = files['next.config.mjs'];
    });

    expect(duringBuild).toBe(already);
    expect(wrapNextConfigForExport(already)).toBe(already);
    expect(files['next.config.navroop-original.mjs']).toBeUndefined();
  });
});
