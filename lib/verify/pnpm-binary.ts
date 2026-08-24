import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Makes `pnpm audit` runnable on a machine where `pnpm` is not on PATH.
 *
 * The audit step is the one command in `VERIFY_STEPS` that still shells out to pnpm —
 * it resolves the lockfile itself and has no vendored binary equivalent. With
 * `shell: true` the name is resolved through PATH, and on this machine there is no
 * `pnpm` there: `.cursor/rules/single-dev-server.mdc` says so in as many words, and
 * prescribes corepack, which honours the `packageManager` pin so the fallback runs the
 * same version rather than whatever happens to be global.
 *
 * Without this the step failed in 0.0s with "command not found" — indistinguishable in
 * the summary from an audit that found a high-severity advisory, and impossible to fix
 * by changing anything in the diff. It is the last of the reasons `pnpm run verify`
 * could not pass from `.husky/pre-push`.
 *
 * Rewriting here rather than in `VERIFY_STEPS` keeps the declared command honest:
 * `docs/release.md` and the reproduce line both say `pnpm audit --audit-level=high`,
 * which is what an operator with pnpm on PATH should type. This is about how the
 * command is spawned, not what it is.
 */

/** Cached so a multi-step run probes once, not per command. */
let onPath: boolean | undefined;

function pnpmOnPath(): boolean {
  if (onPath !== undefined) return onPath;
  const probe = spawnSync('pnpm', ['--version'], { shell: true, encoding: 'utf8' });
  onPath = probe.status === 0;
  return onPath;
}

/** Corepack ships with Node, so this is the path Node's own installer wrote. */
export function corepackEntry(
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
): string | null {
  const candidate = join(
    env.ProgramFiles ?? 'C:/Program Files',
    'nodejs',
    'node_modules',
    'corepack',
    'dist',
    'corepack.js',
  );
  return exists(candidate) ? candidate : null;
}

/**
 * The command as it should actually be spawned. Anything that is not a bare `pnpm …`
 * invocation is returned untouched, and so is a `pnpm …` on a machine that has it —
 * the rewrite is a fallback, never the normal path.
 */
export function resolvePnpmCommand(
  command: string,
  deps: {
    hasPnpm?: () => boolean;
    corepack?: () => string | null;
    node?: string;
  } = {},
): string {
  if (!/^pnpm\s/.test(command)) return command;
  const hasPnpm = deps.hasPnpm ?? pnpmOnPath;
  if (hasPnpm()) return command;

  const entry = (deps.corepack ?? corepackEntry)();
  // No corepack either: hand back the original so the failure is pnpm's own
  // "not found", which names the real problem, rather than a corepack path that
  // does not exist and would blame the wrong thing.
  if (!entry) return command;

  const node = deps.node ?? process.execPath;
  return `"${node}" "${entry}" ${command}`;
}
