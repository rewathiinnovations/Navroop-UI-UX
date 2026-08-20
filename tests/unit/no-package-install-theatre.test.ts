import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearGeneration,
  executeGenerationJob,
  getGenerationState,
  setGenerationProjectId,
  startGeneration,
  subscribeGeneration,
  subscribeGenerationJobs,
} from '../../lib/generation/generation-runtime';

/**
 * F-090: the product told people packages were being installed while nothing
 * installed anything.
 *
 * The generate route scanned the reply three ways for package names, sent each
 * one as a `package` progress frame, and shipped the list on `complete` as
 * `packagesToInstall`. The client parked it on `window.pendingPackages`, read it
 * back in `applyGeneratedCode`, and handed it to `startApply` as `packages` —
 * which `runApplyStream` ignored entirely. There was no installer: no install
 * command, no lockfile handling, no failure path. Meanwhile the overlay printed
 * "This may take a moment while npm installs the required packages" behind a
 * stage (`installing`) that nothing ever set.
 *
 * The in-browser preview resolves dependencies to pinned esm.sh URLs
 * (`lib/preview/deps.ts`) and reports what it cannot resolve through
 * `findUnsupportedImports`. That is the real mechanism, and it is the only one.
 */

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const REPLY = ['```tsx{path=src/App.tsx}', 'export default () => null;', '```'].join('\n');

function sseResponse(frames: ReadonlyArray<Record<string, unknown>>) {
  const encoded = new TextEncoder().encode(
    frames.map((frame) => `data: ${JSON.stringify(frame)}\n`).join(''),
  );
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded);
        controller.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
}

function read(relative: string) {
  return readFileSync(join(ROOT, relative), 'utf8');
}

/** Source with `//`, `/*` and ` * ` lines dropped: a comment may name what it deleted. */
function liveCode(relative: string) {
  return read(relative)
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
    .join('\n');
}

describe('no install is announced because none happens', () => {
  let unsubscribeJobs: () => void;
  let unsubscribeState: () => void;
  let statuses: string[];
  let fakeWindow: { pendingPackages?: string[]; dispatchEvent: () => boolean };

  beforeEach(() => {
    clearGeneration();
    unsubscribeJobs = subscribeGenerationJobs(executeGenerationJob);
    setGenerationProjectId('proj-1');
    statuses = [];
    unsubscribeState = subscribeGeneration(() => {
      const status = getGenerationState().generationProgress.status;
      if (status) statuses.push(status);
    });
    // The runtime writes the handshake only when a window exists, so a node
    // environment would make the assertion below vacuous.
    fakeWindow = { dispatchEvent: () => true };
    vi.stubGlobal('window', fakeWindow);
    vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/generate-ai-code-stream')) {
        return Promise.resolve(
          sseResponse([
            // Exactly what the route used to send while nothing installed.
            { type: 'package', name: 'zod', message: 'Package detected: zod' },
            {
              type: 'complete',
              generatedCode: REPLY,
              explanation: 'done',
              packagesToInstall: ['zod'],
            },
          ]),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ project: { id: 'proj-1' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    });
  });

  afterEach(() => {
    unsubscribeState();
    unsubscribeJobs();
    clearGeneration();
    vi.unstubAllGlobals();
  });

  it('parks no package handshake on the window and reports no install', async () => {
    const result = await startGeneration({ prompt: 'build it', model: 'test/model' });

    expect(result.generatedCode).toBe(REPLY);
    // The handshake `applyGeneratedCode` used to read back and pass to a
    // `startApply` that discarded it.
    expect(fakeWindow.pendingPackages).toBeUndefined();
    expect(Object.keys(result)).not.toContain('packagesToInstall');
    // "Installing zod" on the progress rail, with no installer behind it.
    expect(statuses.filter((status) => /install/i.test(status))).toEqual([]);
  });
});

describe('nothing describes a package install that cannot happen', () => {
  it('emits no package frame and ships no install list from the generate route', () => {
    const route = liveCode('app/api/generate-ai-code-stream/route.ts');
    expect(route).not.toMatch(/type:\s*'package'/);
    expect(route).not.toMatch(/packagesToInstall/);
    expect(route).not.toMatch(/StreamedPackageTracker/);
    // The tag scanner the route fed: its only caller was this theatre.
    expect(existsSync(join(ROOT, 'lib/generation/stream-package-tracker.ts'))).toBe(false);
  });

  it('keeps no package field on the generation or apply contracts', () => {
    const types = liveCode('lib/generation/types.ts');
    expect(types).toContain('export type GenerateResult');
    expect(types).not.toMatch(/packagesToInstall/);
    expect(types).not.toMatch(/packages\?:/);
  });

  it('keeps no window handshake in the client runtime or the workspace', () => {
    for (const file of [
      'lib/generation/generation-runtime.ts',
      'components/workspace/GenerationWorkspace.tsx',
    ]) {
      expect(liveCode(file), `${file} still carries the handshake`).not.toMatch(/pendingPackages/);
    }
  });

  it('offers no installing stage to render copy behind', () => {
    const progress = liveCode('components/CodeApplicationProgress.tsx');
    expect(progress).toContain('export interface CodeApplicationState');
    expect(progress).not.toMatch(/'installing'/);
    expect(progress).not.toMatch(/installedPackages/);
    for (const file of [
      'components/workspace/GenerationWorkspace.tsx',
      'lib/generation/generation-runtime.ts',
    ]) {
      expect(liveCode(file), `${file} still names the installing stage`).not.toMatch(
        /'installing'/,
      );
    }
  });

  it('promises no package install in the UI, and says so when asked for one', () => {
    const workspace = read('components/workspace/GenerationWorkspace.tsx');
    // The copy that described an installer nobody wrote.
    expect(workspace).not.toMatch(/npm installs/i);
    expect(workspace).not.toMatch(/Installing packages\.\.\./i);
    // Typing `npm install` is still recognised; the reply names what really
    // resolves the dependency instead of pretending to run an install.
    expect(workspace).toMatch(/nothing to install/i);
    expect(workspace).toMatch(/straight from the CDN/i);
  });
});
