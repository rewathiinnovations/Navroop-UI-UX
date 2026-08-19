import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SETTINGS } from '@/lib/settings/registry';
import { providerConcurrency } from '@/lib/ai/providers';

/**
 * A field on /admin/config that nothing reads is worse than no field at all:
 * the operator pastes a real credential, the badge flips to "Set here", and the
 * value is never used. That shipped four times over — `app.url` (every consumer
 * went to `process.env.APP_URL`), `ai.concurrency` (the queue was pinned at
 * import), `tooling.e2b.apiKey` (the sandbox provider was deleted, the field
 * stayed and invited a billable key), and Morph.
 *
 * So every registry entry must end in one of two states, and this test is what
 * keeps a new one from quietly becoming a third: either some module under lib/
 * or app/ resolves it through `getSetting`, or its help text says plainly that
 * it is not in use — the wording already used on the Morph entry.
 *
 * The scan is textual on purpose. It matches how a reader finds a consumer, it
 * needs no build step, and it fails on the exact mistake it is guarding: adding
 * a key to the registry and no reader anywhere.
 */

const ROOT = process.cwd();

/**
 * The registry itself, the resolver, and the Test button. All three mention
 * every key by definition, so counting them as consumers would make the scan
 * pass for any key — that is precisely how `app.url` looked "used" while only
 * the Test button read it.
 */
const NOT_A_CONSUMER = [
  'lib/settings/registry.ts',
  'lib/settings/resolve.ts',
  'lib/settings/test-group.ts',
];

/** Says, in the operator's own words, that the field does nothing. */
const NOT_IN_USE = /Not in use\./;

function sourceFiles(dir: string, out: string[] = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') sourceFiles(full, out);
    } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
      out.push(full);
    }
  }
  return out;
}

/** Files that call the resolver, and are not the registry machinery itself. */
function consumerSources() {
  return [...sourceFiles(join(ROOT, 'lib')), ...sourceFiles(join(ROOT, 'app'))]
    .filter((file) => {
      const rel = file.slice(ROOT.length + 1).replace(/\\/g, '/');
      return !NOT_A_CONSUMER.includes(rel);
    })
    .map((file) => ({ file, source: readFileSync(file, 'utf8') }))
    .filter(({ source }) => /\bgetSettings?\(|\bhasSettings\(/.test(source));
}

const CONSUMERS = consumerSources();

function readersOf(key: string) {
  return CONSUMERS.filter(({ source }) => source.includes(`'${key}'`)).map(({ file }) =>
    file.slice(ROOT.length + 1).replace(/\\/g, '/'),
  );
}

describe('every setting on /admin/config reaches a consumer', () => {
  it('finds the resolver callers to scan', () => {
    // A broken scan would silently pass every key. lib/storage, lib/email,
    // lib/backup and friends all resolve settings, so this is never near zero.
    expect(CONSUMERS.length).toBeGreaterThan(8);
  });

  it('has a reader, or says it is not in use', () => {
    const orphans = SETTINGS.filter(
      (entry) => readersOf(entry.key).length === 0 && !NOT_IN_USE.test(entry.help),
    ).map((entry) => entry.key);

    expect(orphans).toEqual([]);
  });

  it('explains itself when it admits to being unused', () => {
    for (const entry of SETTINGS.filter((row) => NOT_IN_USE.test(row.help))) {
      // "Not in use." alone leaves the operator guessing whether to delete the
      // value, the field, or their afternoon.
      expect(entry.help.length).toBeGreaterThan(40);
    }
  });

  it('does not offer a key for a subsystem that was deleted', () => {
    // The sandbox providers went with migration 20260819010000_drop_sandbox_columns.
    expect(SETTINGS.map((entry) => entry.key)).not.toContain('tooling.e2b.apiKey');
  });

  it('advertises the concurrency default the queue actually starts at', () => {
    // The field read "4" while the runtime ran 2. A config screen showing a
    // number the runtime ignores is the same lie as a field nothing reads.
    const entry = SETTINGS.find((row) => row.key === 'ai.concurrency');
    expect(entry?.fallback).toBe(String(providerConcurrency({})));
  });
});
