import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  armProjectGeneration,
  projectArmKey,
  takeProjectArm,
} from '@/lib/projects/start-from-prompt';

/**
 * The arm is the "I just created this project, get on with it" handoff, and it ends in a chat
 * send that can start a build — so a misdirected or replayed arm spends real money.
 *
 * It used to be global sessionStorage keys: `navroopPrompt` for a prompt, `targetUrl` +
 * `autoStart` + `navroopImportMode` for a URL import. Neither named a project.
 *
 *   - The workspace read `navroopPrompt` for whatever project its own URL pointed at, so an
 *     arm for A was auto-sent into B when B was what opened next.
 *   - An arm nothing consumed — a failed project fetch, a back button, a second tab — stayed
 *     in the tab and started a paid build on the next project merely opened, from the earlier
 *     project's URL.
 *
 * These cases are the two claims that stop that: an arm belongs to one project id, and it is
 * spent when it is taken.
 */

/** A sessionStorage the arm helpers can use; the suite runs without a DOM. */
function stubSessionStorage() {
  const store = new Map<string, string>();
  vi.stubGlobal('window', {});
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  });
  return store;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('arming a freshly created project', () => {
  it('is taken by the project it was armed for, and by no other', () => {
    stubSessionStorage();
    armProjectGeneration('proj_a', 'A landing page for a Pune bakery');

    // Opening any other project must find nothing — this is the case that used to auto-send
    // project A's prompt into project B.
    expect(takeProjectArm('proj_b')).toBeNull();
    expect(takeProjectArm('proj_c')).toBeNull();
    expect(takeProjectArm('proj_a')).toBe('A landing page for a Pune bakery');
  });

  it('is consumed exactly once, so a remount cannot send it again', () => {
    stubSessionStorage();
    armProjectGeneration('proj_a', 'Build me a bakery site');

    expect(takeProjectArm('proj_a')).toBe('Build me a bakery site');
    // StrictMode double-mount, a back-and-forward, a second workspace mount in this tab.
    expect(takeProjectArm('proj_a')).toBeNull();
    expect(takeProjectArm('proj_a')).toBeNull();
  });

  it('leaves nothing behind in storage once taken', () => {
    const store = stubSessionStorage();
    armProjectGeneration('proj_a', 'Build me a bakery site');
    expect(store.has(projectArmKey('proj_a'))).toBe(true);

    takeProjectArm('proj_a');

    expect(store.size, 'a spent arm cannot be inherited by the next project').toBe(0);
  });

  it('keeps two projects armed in the same tab apart', () => {
    stubSessionStorage();
    armProjectGeneration('proj_a', 'Bakery site');
    armProjectGeneration('proj_b', 'Dental clinic site');

    expect(takeProjectArm('proj_b')).toBe('Dental clinic site');
    expect(takeProjectArm('proj_a')).toBe('Bakery site');
  });

  it('does not arm a URL import: the ImportSource row is what resumes it', () => {
    const store = stubSessionStorage();
    armProjectGeneration('proj_a', 'https://example.com/');

    expect(store.size).toBe(0);
    expect(takeProjectArm('proj_a')).toBeNull();
  });

  it('does not arm a blank prompt', () => {
    stubSessionStorage();
    armProjectGeneration('proj_a', '   \n  ');
    expect(takeProjectArm('proj_a')).toBeNull();
  });

  it('writes only its own key, never a global one', () => {
    const store = stubSessionStorage();
    armProjectGeneration('proj_a', 'Bakery site');

    expect([...store.keys()]).toEqual(['navroop_arm_proj_a']);
  });
});

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

function source(relative: string) {
  return readFileSync(path.join(repoRoot, relative), 'utf8');
}

/**
 * A source claim, narrowly: the bug was the *existence* of unscoped keys, and the workspace
 * that reads them is a 2800-line client component the unit suite cannot render. Every name
 * below was a live read or write until this change.
 */
describe('the global handoff keys are gone', () => {
  const UNSCOPED = ['navroopPrompt', 'autoStart', 'navroopImportMode'];

  it('is not written by the create-a-project paths', () => {
    const arm = source('lib/projects/start-from-prompt.ts');

    for (const key of UNSCOPED) {
      expect(arm, `${key} must not come back`).not.toContain(`'${key}'`);
    }
    // The URL import arm is the same hazard under another name.
    expect(arm).not.toContain(`'targetUrl'`);
  });

  it('is not read or written by the workspace', () => {
    const workspace = source('components/workspace/GenerationWorkspace.tsx');
    const keys = [...workspace.matchAll(/sessionStorage\.(?:get|set|remove)Item\('([^']+)'/g)].map(
      (match) => match[1],
    );

    // Brand extension has its own pair and is a page-local flag pair, not a project handoff.
    expect([...new Set(keys)].sort()).toEqual(['brandExtensionMode', 'brandExtensionPrompt']);
    expect(workspace).toContain('takeProjectArm');
  });
});
