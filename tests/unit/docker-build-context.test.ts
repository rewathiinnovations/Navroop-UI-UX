import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { minimatch } from 'minimatch';
import { describe, expect, it } from 'vitest';

/**
 * What actually reaches `docker build` (F-713) and which pnpm builds it (F-716).
 *
 * Both files are static, so this suite is the only thing that can hold them: `.dockerignore`
 * patterns without a separator match at the root and nowhere else, which let a sibling git
 * worktree's `node_modules`, `.next` and — the serious part — its `.env.local` into the build
 * context and the `builder` layer. And the Dockerfile prepared pnpm 9.15.9 for a repo whose
 * `packageManager` says 11: either corepack silently downloaded 11 anyway, or pnpm 9 read a
 * v9 lockfile plus `pnpm-workspace.yaml` keys it does not understand and dropped the security
 * `overrides` that pin tar and deepmerge-ts.
 */

const root = join(import.meta.dirname, '..', '..');
const dockerignore = readFileSync(join(root, '.dockerignore'), 'utf8');
// Instructions only. The comments above them quote the very strings these tests forbid
// (`corepack prepare`, `pnpm exec`, the old 9.15.9 pin), which is the point of the comments.
const dockerfile = readFileSync(join(root, 'Dockerfile'), 'utf8')
  .split(/\r?\n/)
  .filter((line) => !line.trimStart().startsWith('#'))
  .join('\n');
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  packageManager: string;
};

const patterns = dockerignore
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line.length > 0 && !line.startsWith('#'));

/**
 * Docker's own matcher (`patternmatcher.MatchesOrParentMatches`): a path is excluded when it
 * or any ancestor matches, later patterns override earlier ones, and a `!` pattern
 * re-includes. Modelled here rather than assumed, because the whole finding is that the
 * matching rule is not the one the file was written against.
 */
function isExcluded(path: string) {
  const segments = path.split('/');
  const candidates = segments.map((_, index) => segments.slice(0, index + 1).join('/'));
  let excluded = false;
  for (const pattern of patterns) {
    const negated = pattern.startsWith('!');
    const glob = negated ? pattern.slice(1) : pattern;
    if (candidates.some((candidate) => minimatch(candidate, glob, { dot: true }))) {
      excluded = !negated;
    }
  }
  return excluded;
}

describe('.dockerignore excludes at every depth', () => {
  it.each([
    'node_modules/next/package.json',
    '.next/BUILD_ID',
    '.env',
    '.env.local',
    '.env.example',
    '.env.sentry-build-plugin',
    'generated/prisma/index.js',
    'coverage/lcov.info',
  ])('keeps the top-level %s out', (path) => {
    expect(isExcluded(path)).toBe(true);
  });

  it.each([
    '.worktrees/main/node_modules/next/package.json',
    '.worktrees/main/.next/BUILD_ID',
    '.worktrees/main/.env.local',
    '.worktrees/main/lib/db.ts',
    '.claude/worktrees/feature/.env',
    '.claude/settings.json',
    '.worktrees/main/packages/x/node_modules/y/index.js',
    'e2b-template-next/.env',
  ])('keeps the nested %s out', (path) => {
    expect(isExcluded(path)).toBe(true);
  });

  it.each([
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    '.npmrc',
    'next.config.ts',
    'tsconfig.json',
    'postcss.config.mjs',
    'instrumentation.ts',
    'docker-entrypoint.mjs',
    'prisma/schema.prisma',
    'app/layout.tsx',
    'components/workspace/ChatPanel.tsx',
    'lib/cron/handle.ts',
    'hooks/useStaticPreview.ts',
    'styles/main.css',
    'scripts/copy-preview-vendor.mjs',
    'scripts/pre-migrate.ts',
    'public/file.svg',
    'README.md',
  ])('still ships %s, which the build needs', (path) => {
    expect(isExcluded(path)).toBe(false);
  });

  it('anchors every credential and install pattern at any depth', () => {
    const depthSensitive = patterns.filter((pattern) =>
      /(^|\/)(\.env|\.env\.\*|node_modules|\.next|generated|\.git)$/.test(pattern),
    );
    expect(depthSensitive.length).toBeGreaterThan(0);
    for (const pattern of depthSensitive) {
      expect(pattern, `${pattern} only matches at the root`).toMatch(/^\*\*\//);
    }
  });

  it('names the second-checkout directories explicitly', () => {
    expect(patterns).toContain('.worktrees');
    expect(patterns).toContain('.claude');
  });
});

describe('Dockerfile pnpm', () => {
  it('does not pin a pnpm version beside package.json packageManager', () => {
    // `corepack prepare pnpm@<version>` was a second source of truth that drifted once
    // already - and corepack itself is gone now: three deploys died to three different
    // corepack failures on the then-node:20 image (pre-rotation signing keys, @latest
    // refusing Node 20, 0.31.0 crashing with ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING),
    // and a fourth exposed the real constraint - pnpm 11.21 needs Node >= 22.13, which
    // is why the base image is node:22 now (see dockerfile-health.test.ts). The
    // declared pnpm is installed through npm, with the version read from package.json at
    // build time, so there is still exactly one place the number lives.
    expect(dockerfile).not.toMatch(/corepack/);
    const pinned = dockerfile.match(/pnpm@(\d+\.\d+\.\d+)/g) ?? [];
    expect(pinned).toEqual([]);
  });

  it('installs the packageManager version and asserts it before installing dependencies', () => {
    // The install reads package.json rather than repeating the version, and the check
    // beside it fails the build if the installed pnpm is not the declared one.
    expect(dockerfile).toMatch(
      /npm install -g pnpm@"\$\(node -p "require\('\.\/package\.json'\)\.packageManager\.split\('@'\)\[1\]"\)"/,
    );
    expect(dockerfile).toMatch(/packageManager/);
    expect(packageJson.packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+$/);
  });

  it('calls the prisma CLI directly rather than through pnpm exec', () => {
    expect(dockerfile).not.toMatch(/pnpm exec/);
    expect(dockerfile).toMatch(/node \.\/node_modules\/prisma\/build\/index\.js generate/);
  });
});
