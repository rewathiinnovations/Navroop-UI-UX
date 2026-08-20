# Code generation vs. upstream open-lovable

A comparison of our generation pipeline against [firecrawl/open-lovable](https://github.com/firecrawl/open-lovable), the project this repo forked from.

Dated 2026-08-19. Re-run the commands in [Verifying this document](#verifying-this-document) before trusting it after upstream moves.

## Summary

**We are not behind upstream.** `firecrawl/main` is a _direct ancestor_ of `HEAD` — merge-base and upstream tip are both `69bd93b` ("v3", 2025-11-19), and a live `git ls-remote` confirms the ref is current. Upstream has shipped **zero commits in nine months**. There is nothing to merge.

On design, accessibility, images, SEO, multi-stack support, provider failover, and job/credit accounting we are substantially ahead. Every real gap was self-inflicted by our own fork commits, and the five below have been fixed.

## Findings

### A. Morph fast-apply was dead in production — fixed

Morph is the headline feature of upstream's v3. Ours was broken two independent ways.

**A1 — the on-switch and the API key read different sources.** Both routes gated on an env var while the code that actually calls Morph read the admin setting:

| Location                                   | Source                               |
| ------------------------------------------ | ------------------------------------ |
| `app/api/generate-ai-code-stream/route.ts` | `process.env.MORPH_API_KEY`          |
| `app/api/apply-ai-code-stream/route.ts`    | `process.env.MORPH_API_KEY`          |
| `lib/morph-fast-apply.ts`                  | `getSetting('tooling.morph.apiKey')` |

`tooling.morph.apiKey` declares `env: 'MORPH_API_KEY'` (`lib/settings/registry.ts`), so `getSetting` resolves **DB row → env var**. Enter the key in `/admin/config` — the documented path under this repo's `admin-panel-settings-over-env` convention — and `MORPH_API_KEY` stays unset, so the gate was `false`, the model was never told to emit `<edit>` blocks, and **Morph silently never ran**. The inverse (env set, DB blank) was worse: the model emitted `<edit>` blocks, the gate passed, and then every edit threw.

**Fix:** one `isMorphConfigured()` helper in `lib/morph-fast-apply.ts`, used by all three call sites.

**A2 — path normalization was React-shaped, and our default stack is Next.js.** `normalizeProjectPath` forced a `src/` prefix on every stack, using a hardcoded React config-file list instead of the stack registry. On NEXTJS — our `DEFAULT_STACK` — `app/page.tsx` became `src/app/page.tsx`, so the read missed and the edit landed in a stray file. The apply route gets this right via `shouldForceSrcPrefix(stack)`; Morph bypassed it.

**Fix:** `normalizeProjectPath(path, stack)` now delegates to `shouldForceSrcPrefix` and `isStackConfigFile` from `lib/stacks.ts`. `stack` is a required parameter — there is no default, because a silent React-shaped default is what caused the bug. Covered by per-stack tests in `tests/unit/morph-fast-apply.test.ts`.

Fixing A1 alone would have immediately broken edits on the default stack, so both landed together.

### B. Two AI SDK v5 options were silently ignored — fixed

`package.json` pins `ai ^5.0.0`; installed is **5.0.237**. v5 renamed two options, and the generate route still passed the v4 names:

| v4 name (was)                   | v5 name (now)     | Consequence while broken                           |
| ------------------------------- | ----------------- | -------------------------------------------------- |
| `maxTokens: 8192`               | `maxOutputTokens` | Output cap never applied                           |
| `experimental_providerMetadata` | `providerOptions` | **GPT-5 never received `reasoningEffort: 'high'`** |

Verified against the installed type definitions:

```
node_modules/ai/dist/index.d.ts   maxOutputTokens: 6   maxTokens: 0
                                  providerOptions: 23  experimental_providerMetadata: 0
```

`streamOptions` was declared `const streamOptions: any`, which is exactly why `tsc` never caught it. **Upstream has the identical bug** at its lines 1308/1321 — inherited, not a regression.

**Fix:** renamed both, and replaced `: any` with `Parameters<typeof streamText>[0]`. The typing is the durable half — the renames alone would regress later. Verified in both directions: the new shape typechecks clean, and reintroducing `maxTokens` now fails with `TS2353: 'maxTokens' does not exist in type ...`.

Because the cap had never actually applied, renaming it alone would have newly _imposed_ an 8192-token ceiling and made truncation worse. `appConfig.ai.maxTokens` was raised 8000 → 32000 in the same change, and is taken as `min(config, plan.maxTokensPerJob)` so plan limits still win. The truncation-recovery call, which set no cap and ignored the existing `truncationRecoveryMaxTokens`, now honors it.

### C. The failover chain silently dropped to weak models — fixed

`lib/ai/providers.ts` held a second source of model truth that disagreed with `config/app.config.ts`:

```ts
openai:    'gpt-4o-mini',              // small/cheap — weak at codegen
anthropic: 'claude-sonnet-4-20250514', // May 2025
google:    'gemini-2.0-flash',         // older than app.config's 2.5-flash
```

`loadProviderChain` dedupes by **provider**, so the chain ran `google/<requested> → openai/gpt-4o-mini → anthropic/claude-sonnet-4 → groq/kimi`. When Gemini rate-limited, the user's app was generated by `gpt-4o-mini`, surfaced only as a `failoverNotice` string. Invisible in `app.config.ts`, and the most likely cause of erratic real-world quality.

**Fix:** `DEFAULT_MODELS` raised to codegen-capable tiers. This is the fix that matters most in production, because it binds on every fallback hop.

### D. Model lineup was behind upstream — fixed

Upstream's v3 was substantially _about_ moving to Gemini 3 Pro. We carried the commit but reverted the choice and didn't offer the model at all:

```diff
-    defaultModel: 'google/gemini-3-pro-preview',
+    defaultModel: 'google/gemini-2.5-flash',
```

**Fix:** Gemini 3 Pro restored as default; Claude Opus 5 and Sonnet 5 added; 2.5-flash kept as the cheap option. `app.config.ts` and `lib/ai/providers.ts` moved together — otherwise the UI offers a model the failover chain then abandons.

### E. Edit discipline was missing from five of six stacks — fixed

Narrower than a file-tree diff suggests. When this was written, upstream's `lib/context-selector.ts` and `lib/edit-examples.ts` were byte-identical copies in this tree and `selectFilesForEdit` fed `buildSystemPrompt()` output into the generate route. **Both files were deleted on 2026-08-20** by the dead-code sweep: nothing imported them any more (`selectFilesForEdit` now appears nowhere under `lib/` or `app/`), so the 9 worked edit examples, "DO NOT CREATE NEW FILES WITH SIMILAR NAMES" and the "surgeon making a precise incision" framing they carried are no longer in the repository. Edit discipline today is the per-stack rules below — `nextjs.ts`, `react.ts` and `static-html.ts` each carry an `Edits:` block — plus the selective file context in `lib/generation/`. If edit quality regresses on `/admin/quality`, re-add the missing instructions as a stack prompt rule rather than resurrecting the upstream files.

What **was** missing: per-stack file-count discipline. `grep -l "Edits:" lib/stack-prompts/*.ts` returned exactly one file — `react.ts`. `nextjs.ts`, `astro.ts`, `vue.ts`, `svelte.ts`, and `static-html.ts` had no equivalent, and NEXTJS is our default.

**Fix:** each of the five now carries a "check the layout / existing routes first" and "1 file for style/text, 2 max for a new component, never regenerate" rule in its own vocabulary. Upstream's code-snippet display rule was added once to `COMPLETION_RULES` in `shared.ts`.

Upstream's "don't hand-roll SVGs" rule (commit `defd90a`) needed no action — `lib/ui-ux-pro-max/build-design-brief.ts` already says "Use Lucide or Heroicons only. Never use emoji as icons," and preserves it in edit mode.

Editing a stack prompt rolls a new labeled `PromptVersion` via `currentPromptHash()`, so `/admin/quality` will attribute any quality change to this edit.

### F. Not gaps

Recorded because a structural diff makes them look like losses:

- **Anti-recreate context survives** — the `RECENTLY CREATED/EDITED FILES (DO NOT RECREATE THESE)` block is present in the generate route.
- **Route shrinkages are extractions** — `install-packages`, `get-sandbox-files`, and `analyze-edit-intent` became thin auth wrappers over `lib/`. The logic moved; it wasn't deleted.
- **Dropping Vercel Sandbox was intentional** — replaced by the e2b/modal/daytona router. It is the only file upstream has that we don't.
- **We fixed a real upstream Morph bug** — upstream treats a _failed_ `cat` as an empty file; our `successfulCommandStdout()` checks `exitCode === 0`.

## Known remaining gap

`lib/build-validator.ts` is **orphaned in both trees** — it has error classification and retry-backoff logic that nothing imports. Neither we nor upstream have a closed-loop "build error → re-prompt → re-apply" cycle; upstream's `check-vite-errors` route is a stub returning `{errors: []}`. This is the largest remaining codegen opportunity and is not addressed here.

## Verifying this document

```bash
git fetch firecrawl && git merge-base HEAD firecrawl/main && git rev-parse firecrawl/main
```

Identical output means upstream is still fully contained in `HEAD` and section A–F still stand as written.

```bash
grep -rn "maxTokens\|experimental_providerMetadata" app/ lib/ --include=*.ts
```

Should return only `maxTokensPerJob` (a distinct `Plan` field). Any bare `maxTokens` in a `streamText` call is finding B regressing — though it now fails `tsc` first.

```bash
grep -L "Edits:" lib/stack-prompts/{astro,nextjs,react,static-html,svelte,vue}.ts
```

Should return nothing. Any file listed has lost its edit-discipline rule (finding E).
