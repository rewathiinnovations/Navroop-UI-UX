import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // Was `off` with no justification (F-790), so the `--max-warnings 0` gate was
      // blind to the `any`-typed plumbing it was supposed to catch. Measured
      // 2026-08-21: 82 violations, of which 21 were live code (now typed) and 61 sat
      // in nine modules with no importer. Those nine went with the rest of F-448’s
      // unreachable tree, so the bounded `off` they justified is gone too: the rule
      // now has no exemption anywhere. Do not add one — type the `any` instead.
      '@typescript-eslint/no-explicit-any': 'error',
      // Was `off`, with no justification beside it, so `verify`'s
      // `--max-warnings 0` gate was blind to unused imports, unused locals and
      // unused module-level functions — the structural reason dead code
      // accumulated in this tree (F-803). `_`-prefixed args and caught errors
      // are the opt-out: a deliberately unused parameter says so in its name.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
      // Bare `catch {}` / empty blocks turned real failures into a plausible
      // success (storage, Morph mkdir, cache writes). Comments inside a
      // catch are allowed only when the failure is an expected fallback.
      'no-empty': 'error',
      // Both stay off, with the measurement that justifies it. Counted 2026-08-21
      // under `--rule`: exhaustive-deps 15 violations in 9 files,
      // set-state-in-effect 61 in 50. Unlike the three rules above, neither has a
      // mechanical fix — every one is a behaviour change to a live hook (a wrong
      // dependency set turns a poller into a render loop) and needs the surface it
      // touches exercised in a browser. F-790 asked for them; they are a scoped
      // piece of work with UI verification, not a config flip. Do not enable one
      // without fixing its violations: `verify` runs `--max-warnings 0`.
      'react-hooks/exhaustive-deps': 'off',
      'react-hooks/set-state-in-effect': 'off',
      // Both measured at 0 violations on 2026-08-21, so these were pure gate
      // surface area: `off` for no reason, protecting nothing.
      'react/no-unescaped-entities': 'error',
      'prefer-const': 'error',
    },
  },
  {
    files: ['**/live-preview-frame.tsx'],
    rules: {
      '@next/next/no-img-element': 'off', // Dynamic WebSocket stream images require regular img tag
    },
  },
  globalIgnores([
    '.next/**',
    'out/**',
    'build/**',
    'next-env.d.ts',
    'generated/**',
    'examples/**',
    'coverage/**',
    'playwright-report/**',
    'test-results/**',
    // Published preview builds written at runtime, already gitignored.
    'public/uploads/**',
    // Vendored skill scripts (CommonJS). Not app source.
    '.cursor/**',
    // Nested Claude worktrees / skill copies. Not app source.
    '.claude/**',
    '**/.claude/**',
    // Sibling git worktrees for other branches, already gitignored. Their whole
    // tree is another branch's checkout: linting it reports that branch's files
    // against this branch's config, which is how 17 errors appeared in vendored
    // `.cjs` skill scripts nobody here had touched.
    '.worktrees/**',
    '**/.worktrees/**',
  ]),
]);

export default eslintConfig;
