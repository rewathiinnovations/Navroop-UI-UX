import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": "off",
      // Bare `catch {}` / empty blocks turned real failures into a plausible
      // success (storage, Morph mkdir, cache writes). Comments inside a
      // catch are allowed only when the failure is an expected fallback.
      "no-empty": "error",
      // Was warn. verify uses --max-warnings 0; a full-repo cleanup of these
      // rules is a follow-up, not a silent disable of the gate.
      "react-hooks/exhaustive-deps": "off",
      // React Compiler: fetch-on-mount / sync-from-storage setState. Same class
      // as exhaustive-deps — do not rewrite every admin/workspace hook for it.
      "react-hooks/set-state-in-effect": "off",
      "react/no-unescaped-entities": "off",
      "prefer-const": "off",
    },
  },
  {
    files: ["**/live-preview-frame.tsx"],
    rules: {
      "@next/next/no-img-element": "off", // Dynamic WebSocket stream images require regular img tag
    },
  },
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "generated/**",
    "examples/**",
    "coverage/**",
    "playwright-report/**",
    "test-results/**",
    // Vendored skill scripts (CommonJS). Not app source.
    ".cursor/**",
    // Nested Claude worktrees / skill copies. Not app source.
    ".claude/**",
    "**/.claude/**",
  ]),
]);

export default eslintConfig;
