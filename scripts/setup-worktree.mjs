/**
 * One command for the four steps a fresh worktree needs before it can run anything.
 *
 * A worktree under `.claude/worktrees/` (or `.worktrees/`) starts with no `.env`, no
 * `node_modules` and no generated Prisma client. Skipping the last one is the expensive
 * mistake: every import of `lib/db` resolves through `@/generated/prisma`, so without it
 * `tsc` emits ~180 cascading errors and every test file dies at import — breakage that
 * looks like the branch and is not.
 *
 * The steps are `.cursor/rules/single-dev-server.mdc`'s own "Setting up a second tree"
 * recipe, executed rather than copy-pasted. What it deliberately does NOT do is start a
 * dev server: that rule reserves start/restart for the one agent that owns the tree's
 * port, and a script that quietly started a second one would institutionalise the exact
 * collision the rule exists to prevent.
 *
 *   node scripts/setup-worktree.mjs
 *
 * Idempotent — every step is skipped if it has already been done, so it is safe to re-run
 * after an interrupted setup.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const CWD = process.cwd();

/** `.env*` files are secrets: copied by path, never read, never printed. */
const ENV_FILES = ['.env', '.env.local'];

function step(label) {
  process.stdout.write(`\n\u001b[1m${label}\u001b[0m\n`);
}

function done(message) {
  process.stdout.write(`  \u2713 ${message}\n`);
}

function skip(message) {
  process.stdout.write(`  \u00b7 ${message}\n`);
}

function fail(message) {
  process.stderr.write(`  \u2717 ${message}\n`);
  process.exitCode = 1;
}

/**
 * The main checkout, found through git rather than by walking up looking for a marker:
 * `--git-common-dir` is the one path every linked worktree shares, and its parent is the
 * checkout that owns it. Walking up would land on whichever ancestor happened to hold a
 * `.env`, which on this machine is a different project entirely.
 */
function mainCheckout() {
  try {
    const common = execFileSync(
      'git',
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      {
        cwd: CWD,
        encoding: 'utf8',
      },
    ).trim();
    return resolve(common, '..');
  } catch {
    return null;
  }
}

/** Runs a command, streaming its output. Returns true on exit 0. */
function run(command, args) {
  const result = spawnSync(command, args, { cwd: CWD, stdio: 'inherit', shell: false });
  return result.status === 0;
}

/**
 * `pnpm` is frequently not on an agent shell's PATH here, but corepack is and it honours
 * the `packageManager` pin in package.json — so the fallback installs the same version
 * rather than whatever is global. The npm-side runners are never candidates: one of them
 * has already rewritten `pnpm-workspace.yaml` in this repo, and
 * `tests/unit/script-invocation-docs.test.ts` forbids naming them in a script at all.
 */
function pnpmCommand() {
  const probe = spawnSync('pnpm', ['--version'], { shell: true, encoding: 'utf8' });
  if (probe.status === 0) return { command: 'pnpm', args: [], via: `pnpm ${probe.stdout.trim()}` };

  const corepack = join(
    process.env.ProgramFiles ?? 'C:/Program Files',
    'nodejs',
    'node_modules',
    'corepack',
    'dist',
    'corepack.js',
  );
  if (existsSync(corepack))
    return { command: process.execPath, args: [corepack, 'pnpm'], via: 'corepack' };
  return null;
}

// ---------------------------------------------------------------- 1. secrets

step('1/4  Environment files');
const main = mainCheckout();
if (main === null) {
  fail('not inside a git checkout');
} else if (resolve(main) === resolve(CWD)) {
  skip('this is the main checkout, not a worktree — nothing to copy');
} else {
  for (const file of ENV_FILES) {
    const target = join(CWD, file);
    const source = join(main, file);
    if (existsSync(target)) {
      skip(`${file} already present`);
    } else if (!existsSync(source)) {
      skip(`${file} absent from the main checkout too — nothing to copy`);
    } else {
      copyFileSync(source, target);
      done(`${file} copied from ${basename(main)} (contents not read)`);
    }
  }
}

// -------------------------------------------------------------- 2. node_modules

step('2/4  Dependencies');
if (existsSync(join(CWD, 'node_modules', '.bin'))) {
  skip('node_modules already installed');
} else {
  const pnpm = pnpmCommand();
  if (pnpm === null) {
    fail('neither pnpm nor corepack found — cannot install');
  } else {
    process.stdout.write(`  running install via ${pnpm.via}\n`);
    // --ignore-scripts keeps a fresh worktree from running lifecycle scripts against a
    // tree that has no generated client yet; `prepare` (husky) is the main checkout's job.
    const ok = run(pnpm.command, [
      ...pnpm.args,
      'install',
      '--frozen-lockfile',
      '--ignore-scripts',
    ]);
    if (ok) done('dependencies installed');
    else fail('install failed — see the output above');
  }
}

// ------------------------------------------------------------ 3. prisma client

step('3/4  Prisma client');
const prismaEntry = join(CWD, 'node_modules', 'prisma', 'build', 'index.js');
if (existsSync(join(CWD, 'generated', 'prisma'))) {
  skip('generated/prisma already present');
} else if (!existsSync(prismaEntry)) {
  fail('prisma is not installed — step 2 must succeed first');
} else {
  // The direct binary rather than a package-manager wrapper: pnpm runs a dependency-status
  // check before it resolves one, and that check can offer to purge node_modules out from
  // under a running server. `tests/unit/script-invocation-docs.test.ts` bans the wrappers by
  // name here, with no escape hatch, so this comment does not spell them either.
  const ok = run(process.execPath, [prismaEntry, 'generate']);
  if (ok) done('generated/prisma written');
  else fail('prisma generate failed — see the output above');
}

// ----------------------------------------------------------- 4. preview vendor

step('4/4  Preview vendor bundle');
const vendorScript = join(CWD, 'scripts', 'copy-preview-vendor.mjs');
const vendorDir = join(CWD, 'public', 'preview-vendor');
if (existsSync(vendorDir) && readdirSync(vendorDir).length > 0) {
  skip('public/preview-vendor already populated');
} else if (!existsSync(vendorScript)) {
  fail('scripts/copy-preview-vendor.mjs is missing');
} else {
  const ok = run(process.execPath, [vendorScript]);
  if (ok) done('esbuild.wasm copied');
  else fail('copy-preview-vendor failed — see the output above');
}

// ------------------------------------------------------------------- next step

if (process.exitCode) {
  process.stdout.write(
    '\nSetup did not finish. Fix the failure above and re-run — it is idempotent.\n',
  );
} else {
  process.stdout.write(
    [
      '',
      'Ready. This tree can now run tsc, eslint and vitest.',
      '',
      'It cannot start its own dev server: one server per checkout, and start/restart',
      'belongs to the agent that owns this tree\u2019s port. See',
      '.cursor/rules/single-dev-server.mdc for the port table and who to ask.',
      '',
    ].join('\n'),
  );
}
