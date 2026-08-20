import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, posix, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Two orphans shipped in this repo for long enough to become plausible.
 *
 * `/builder` (F-545) was a signed-in page that read a URL out of
 * `sessionStorage`, printed "Analyzing website...", and then rendered a
 * hard-coded HTML string parameterised by a style name — no `fetch`, no `/api`
 * reference anywhere in the file — and offered **Download code** on the result.
 * Nothing in the product linked to it, so the only way in was typing the path,
 * and what you got back was a fabrication.
 *
 * `packages/create-open-lovable` (F-720, F-841) was a `bin`-declaring CLI with a
 * public `publishConfig` that scaffolded the deleted e2b/modal/daytona sandbox
 * providers. It was not a workspace member and had zero references, so nothing
 * here typechecked or linted it, while its one executable path did
 * `fs.remove(path.join(config.path, config.name))` behind a single yes/no prompt
 * and wrote the API keys the user had just typed into a plaintext `.env`.
 *
 * These are the tripwires. A generated site must come from a generation, and a
 * publishable CLI must not ride along in this repo unchecked.
 */

const ROOT = resolve(import.meta.dirname, '..', '..');

const SKIP_DIRS: Record<string, true> = {
  node_modules: true,
  '.next': true,
  dist: true,
  build: true,
  out: true,
};

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(resolve(ROOT, dir), { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS[entry.name]) continue;
      walk(posix.join(dir, entry.name), out);
      continue;
    }
    if (/\.(tsx?|jsx?)$/.test(entry.name)) out.push(posix.join(dir, entry.name));
  }
  return out;
}

describe('no page fabricates a generated site', () => {
  it('has no /builder route left to serve a hard-coded mock', () => {
    expect(existsSync(join(ROOT, 'app/builder'))).toBe(false);
  });

  it('leaves no hard-coded generated-code fixture under app/', () => {
    // The tell was a template literal named for what it was: a mock standing in
    // for "the actual scraping and generation APIs".
    const offenders = walk('app').filter((file) => {
      const source = readFileSync(join(ROOT, file), 'utf8');
      return /mockGeneratedCode|For demo purposes, we'll generate/.test(source);
    });
    expect(offenders).toEqual([]);
  });
});

describe('no unchecked publishable package rides along', () => {
  it('declares no bin under packages/', () => {
    const dir = join(ROOT, 'packages');
    if (!existsSync(dir)) return;
    // A `bin` here is shippable by `npm publish` from a directory that neither
    // tsc nor eslint nor the Docker build ever sees.
    const withBin = readdirSync(dir).filter((name) => {
      const manifest = join(dir, name, 'package.json');
      if (!statSync(join(dir, name)).isDirectory() || !existsSync(manifest)) return false;
      return 'bin' in (JSON.parse(readFileSync(manifest, 'utf8')) as Record<string, unknown>);
    });
    expect(withBin).toEqual([]);
  });

  it('has no scaffolder for the removed sandbox providers', () => {
    expect(existsSync(join(ROOT, 'packages/create-open-lovable'))).toBe(false);
  });

  it('carries no install-time exception for the removed sandbox SDKs', () => {
    // F-842. `pnpm-workspace.yaml` kept `minimumReleaseAgeExclude` entries pinning four
    // `@daytona/*` packages at 0.205.0 — a policy exception, read on every install, for a
    // driver that went with the sandbox subsystem. Nothing imports them and the lockfile no
    // longer mentions them, so the exception was the last surviving signal that the
    // subsystem is current.
    for (const file of ['pnpm-workspace.yaml', 'pnpm-lock.yaml', 'package.json']) {
      expect(
        readFileSync(join(ROOT, file), 'utf8'),
        `${file} still names @daytona/*`,
      ).not.toContain('@daytona/');
    }
  });
});

/**
 * F-766: `types/sandbox.ts` declared `activeSandbox`, `sandboxState` and
 * `existingFiles` as ambient globals, so `global.sandboxState` typechecked
 * anywhere and dead modules kept reading it without the compiler objecting.
 * The file is gone; two smaller residues outlived it — a `sandboxId` on
 * conversation message metadata, and a prompt line that told the model
 * "Current sandbox ID: …" from a value that can no longer be set.
 */
describe('the sandbox subsystem left no ambient residue', () => {
  it('declares no sandbox globals', () => {
    expect(existsSync(join(ROOT, 'types/sandbox.ts'))).toBe(false);
    const offenders = walk('types').filter((file) =>
      /declare\s+global[\s\S]*?\bvar\s+(activeSandbox|sandboxState|existingFiles)\b/.test(
        readFileSync(join(ROOT, file), 'utf8'),
      ),
    );
    expect(offenders).toEqual([]);
  });

  it('records no sandbox id on a conversation message', () => {
    const types = readFileSync(join(ROOT, 'types/conversation.ts'), 'utf8');
    // The interface is still here — this is a field check, not a missing-file check.
    expect(types).toContain('interface ConversationMessage');
    expect(types).not.toContain('sandboxId');
  });

  it('never puts a sandbox id in the generation prompt', () => {
    const route = readFileSync(join(ROOT, 'app/api/generate-ai-code-stream/route.ts'), 'utf8');
    const live = route
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');
    expect(live).toContain('contextParts.push(');
    expect(live).not.toMatch(/sandbox ID/i);
    expect(live).not.toContain('context?.sandboxId');
  });
});
