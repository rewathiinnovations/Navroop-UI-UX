# Validating generated code, and the auto-fix loop

Closes the gap named in [docs/codegen-vs-open-lovable.md](./codegen-vs-open-lovable.md): nothing checked whether generated code actually works, so a broken build ended as _"applied successfully"_ with a blank preview and the user had to notice for us.

This document has been wrong twice, and both times the code was wrong in the same way — a check that could not run while the docs described one that could.

1. `lib/build-validator.ts` fetched the preview HTML and looked for `vite-error-overlay` / `id="root"` — markers only REACT produces, so NEXTJS (the default stack) reported a false pass on every broken build. It was also orphaned: zero importers. Deleted.
2. Its replacement shelled `getStack(stack).buildCommand` into a **sandbox VM** and skipped when there was no sandbox. Migration `20260819010000_drop_sandbox_columns` then deleted the sandbox subsystem, so the check skipped **every single run** — and `runBuildValidation` had no caller at all. That is how `No matching export in "vfs:lib/data.ts" for import "site"` reached a user's browser after chat told them the build had succeeded.

## What runs now

Two checks over the generated file map, cheapest first. Neither can skip for infrastructure reasons, because neither needs infrastructure.

```
generated files (merged with the project's existing files)
  ├─ 1. static import/export scan   (lib/generation/validate-imports.ts)
  │      pure, synchronous, no dependencies, no I/O
  │      └─ problems → report + policy, and stop here
  └─ 2. esbuild bundle              (lib/validation/build-check.ts)
         the same in-process compile the preview and the published site run
         ├─ passes                → done
         ├─ only missing packages → ask for a rewrite using supported packages
         └─ code error            → re-prompt the model (max 2 model attempts)
```

The only skips left are honest ones: `STATIC_HTML` has no module graph, an empty file set has nothing to check, and — the one case that is _reported_ rather than quiet — the bundler itself failing to run (`checker-unavailable`). A generation that produced files is already paid for and already saved, so a checker that cannot start, or throws, must not take it down; but it says so in chat and records a `validate-build` job step, because "not examined" must never read as "passed", and never as a fault the model is asked to fix.

### 1. The static scan

Catches the classes that break the in-browser bundle, per file:

| Problem                                                  | Reported as                         |
| -------------------------------------------------------- | ----------------------------------- |
| relative or `@/`-aliased import of a file that is absent | `unresolved-import` (blocking)      |
| named import of a symbol the target does not export      | `missing-named-export` (blocking)   |
| default import from a file with no default export        | `missing-default-export` (blocking) |
| a file importing itself                                  | `self-import` (blocking)            |
| two or more files importing each other in a circle       | `import-cycle` (**warning only**)   |

A cycle is legal ESM and the bundler accepts it, so it is reported and never repaired — "fixing" it would rewrite working code.

Resolution mirrors `resolveVirtual` in `lib/preview/server-bundle.ts` — the same extension/index/`src/` swap ladder — because the only verdict worth predicting is that bundler's. A test asserts the two agree on the same file map; if they diverge, either a good build gets blocked or a broken one still ships.

Bare specifiers (`react`, `next/image`, `lucide-react`) are skipped **by the static scan**: it has no view of the project's dependency set, and guessing here would flag the `next/*` modules the preview shims. They are not unchecked, though — step 2 refuses the ones the import map cannot serve. See [The dependency contract](#the-dependency-contract).

**False positives are the failure mode that matters.** A wrong "invalid" verdict blocks a working build and spends a generation rewriting correct code, so the scanner passes whenever it is unsure:

- it is a scanner, not a parser — no parser is a dependency of this path — and the module comment lists what it deliberately does not understand;
- CommonJS, an unreadable `export *`, or a re-export chain deeper than four hops makes the target's export set _open_, and an unknown export set can never contradict an import;
- before any missing-export claim, `mentionsSymbol` checks whether the name appears in the target at all. If `lib/data.ts` contains the token `site` anywhere, the likelier reading is that the scanner missed an export form. Word-bounded, so `siteConfig` does not vouch for `site` — the exact shape of the incident.

Problems are reported only for the files the run generated (`changedPaths`); a pre-existing problem in an untouched file is not this build's fault.

### 2. The esbuild bundle

`checkBuild` compiles the assembled project with `buildStaticSite` — the same esbuild pass as the preview. It also catches syntax and JSX errors, and it runs in-process, so there is no VM to be absent. When the static scan has already found something, the bundle is skipped: it would fail on the same import, and the static message names the file and the symbol in plainer English than esbuild does.

## The tool surface

How generated files reach the project at all. Generation used to be one text completion parsed for ` ```lang{path=…} ` fences: the model wrote prose that happened to contain code, and a regex decided what a file was. Every failure of that contract is silent, because a reply parsing to zero files is indistinguishable from a reply that answered a question.

A tool call is a typed, validated boundary instead. `lib/generation/tools/index.ts` registers:

| Tool             | Writes | Notes                                                                                             |
| ---------------- | ------ | ------------------------------------------------------------------------------------------------- |
| `write_file`     | yes    | the complete file; no placeholders, no truncation                                                 |
| `edit_file`      | yes    | one exact string replacement; refuses a zero-match and an ambiguous multi-match, changing nothing |
| `rename_file`    | yes    | write + delete; refuses a missing source or an existing destination                               |
| `delete_file`    | —      | records a deletion the store keeps separately from its writes                                     |
| `read_file`      | no     | a miss names the nearest paths rather than only failing                                           |
| `search_files`   | no     | literal substring, never a regex — a model-supplied pattern is an injection and backtracking risk |
| `add_dependency` | yes    | registers a package from the supported set; see below                                             |

Every writing tool goes through `store.write`, which is `assertWritableGenerationFile` — the same path-safety, binary, size and `package.json`-validity gate a parsed fence gets. Refusals are **returned, never thrown**: a model that reads "search appears 3 times" corrects itself on the next step, whereas a throw ends a run the user has already paid for.

`ai.agentTools` selects the path (Admin → Configuration, group AI providers): `auto` uses tools when the model supports them and falls back to fences when it does not, `on` forces tools, `off` forces fences. The default is `auto`. `ai.maxAgentSteps` caps the tool-calling rounds one generation may take; work already finished is kept when the cap is reached.

### Whether the model supports tools

Measured, not assumed. `scripts/probe-tool-support.ts` resolves the provider exactly as generation does and issues one `generateText` with a trivial tool:

```
node ./node_modules/tsx/dist/cli.mjs scripts/probe-tool-support.ts
```

It prints `MODEL`, `THINKING`, `TOOL_CHOICE_AUTO`, `TOOL_CHOICE_REQUIRED` and a `TOOLS:` verdict. Measured result: **all three DeepSeek models support tools under `toolChoice: 'auto'`, in both thinking modes.** Thinking mode **rejects** `toolChoice: 'required'` outright ("Thinking mode does not support this tool_choice"), which classifies as `malformed` and so would not even fail over — which is why generation sends `'auto'` and why the `TOOLS:` verdict is derived from `auto` alone. Probing `required` only would have recorded `unsupported` for a deployment whose tools work perfectly. `MODEL_SUPPORTS_TOOLS` in `lib/ai/providers.ts` is set from this.

## The dependency contract

Two tiers, both pinned, both in `lib/preview/deps.ts`:

- **`PREVIEW_DEPS`** — always available. React, the shadcn/ui starter kit's Radix primitives, `clsx`, `tailwind-merge`, `class-variance-authority`, `lucide-react`, and a few more. Importable with no ceremony.
- **`OPTIONAL_PREVIEW_DEPS`** — available on request, through `add_dependency`. Twelve packages: `zod`, `react-hook-form`, `@hookform/resolvers`, `embla-carousel-react` and eight further Radix primitives.

`add_dependency` merges the package into the project's `package.json` at **the product's pin**, ignoring any version the model asked for — an open registry lookup, or an honoured `^4`, would put an unreviewed build on the esm.sh import map of every future reload of that project. A name in neither tier is refused, and the refusal lists both tiers so the next step is not another guess. `STATIC_HTML` is refused outright: it has no manifest and no module graph by design.

Nothing is installed. There is no install step, no lockfile and no `node_modules`: `projectPreviewDeps(files)` reads the manifest, adds the optional packages it names at their pins, and the frame's import map points each one at esm.sh. A dependency is **registered**, and resolution is still from the CDN.

### An unresolvable package is a build error

It did not used to be. Both bundlers ended their resolve hook with `if (isBare(path)) return { external: true }` and no allowlist, so an import of a package the import map does not serve compiled cleanly, `checkBuild` reported `passed`, the user was told the build had succeeded, and the failure landed in the iframe as _"The preview could not load one of its packages"_. It also left `decideAutoFix`'s `install` branch dead — nothing ever produced a `missing-package` error for it to act on.

`resolveBareSpecifier` (`lib/preview/resolve-bare.ts`) is now the resolve hook of **both** `lib/preview/bundle.ts` and `lib/preview/server-bundle.ts`. One function on purpose: the two `isBare` predicates had already drifted, and when the preview and the validator disagree about whether a build is broken, one of them is lying to the user. Its error text matches a `MISSING_PACKAGE_PATTERNS` entry in `lib/validation/build-check.ts`, so `extractMissingPackages` populates and `kind: 'missing-package'` is produced with no change to the policy.

The resolved map travels on `PreviewAssembly.deps`, so the bundle and the served document's import map are built from one value — a bundle resolved against a wider set than the frame serves compiles and then fails to load.

## The prompt eval set

Two tiers, because a prompt regression net that costs money per run will not be run.

**Free**, and in `verify`: `tests/unit/stable-prompt-prefix.test.ts` snapshots the whole system prompt per stack × direction, so a prompt edit lands as a reviewable diff instead of an invisible behaviour change. It also pins the cache contract — byte-identical across calls, no per-request data.

**Paid**, and by hand:

```
node ./node_modules/tsx/dist/cli.mjs scripts/eval-prompts.ts --live
```

Twelve cases in `scripts/prompt-eval-cases.json` — a first build, a multi-page site, a pricing page, dark mode, a mobile navbar fix, a validated form, a copy-only edit, a style-only edit, a component extraction, a dependency-requiring request, an ambiguous one-word prompt that must ask rather than build, and a `STATIC_HTML` build. Each carries `expectFiles` and a `mustNotMatch` list of the anti-slop patterns the prompts exist to prevent (`lorem ipsum`, `example.com`, `TODO`, raw hex colours, `style={{`).

Scoring reuses what already decides these questions in production: `checkBuild` for compiles-or-does-not, the file store's written paths for the file count, a regex sweep over the files _and_ the closing reply, and the SDK's own usage for tokens. Results go to `tmp/eval/<ISO timestamp>.json` (gitignored) with a printed table and a pass rate.

**It refuses to run without `--live`** and is deliberately **not** in `VERIFY_STEPS` — a gate that spends real tokens on every invocation is one people learn to skip, and `docs/release.md` pins that step list.

Three things go with the pass rate, because a rate on its own says a run scored 9/12 and not whether it is the same 9:

- **Tool outcomes per case**, counted by tool and by outcome — `ok`, `refused`, `error` — in the printed table and in the JSON. `lib/generation/tools/index.ts` _returns_ its refusals rather than throwing so the model can correct itself, so until this existed a run that burned half its step budget on `search appears 3 times` scored identically to one that never missed. `ok`/`refused` come from the tool surface's own `notify` events; `error` is the remainder between what the model asked for (`step.toolCalls`) and what the surface answered, which is where a call whose arguments failed schema validation shows up — that one never reaches `execute` and emits no event at all. This is the instrument that says whether an `edit_file` tolerance change was worth shipping.
- **A diff against the last run of the same model**, printed and stored under `baseline` in the JSON: newly passing, newly failing, unchanged, and — kept separate, because adding a case is not a regression — cases the two runs do not share. The results files were written and never read before this.
- **A model axis**, `--all-models` or `--models=<id>,<id>`, which repeats the case set per model and prints them side by side. The axis is model rather than provider: `ProviderName` is a one-member union. It is opt-in and it multiplies the bill — a bare `--live` still runs the configured primary alone, which is how the baseline below was measured and the only way it stays comparable. A sweep writes one file per model (`<ISO timestamp>--<model>.json`), each in the same shape a single-model run writes, so every file in `tmp/eval` remains readable as a baseline.

The pass/fail rule of a case is unchanged, and deliberately still a boolean: a weighted score would be a better instrument and would strand every number recorded here.

### Recorded baseline

**9/12 (75%)**, `deepseek-v4-flash`, thinking disabled, 2026-08-27 (`tmp/eval/2026-08-27T10-53-08-055Z.json`). 1.34M tokens in, 52k out. A drop against this is the regression the free tier cannot see.

The harness diffs against it by itself now — but only if that file is still on the machine: `tmp/` is gitignored, so a fresh clone has no history and the first run of a model reports `no earlier run of this model in tmp/eval` rather than a comparison. The numbers here are the record that survives a clone; keep them updated when a run supersedes them.

The three failures are prompt findings, not harness noise, and are open:

| Case                   | Observed                                                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `pricing-page`         | wrote a `$0` price — a placeholder amount on a page whose whole subject is prices                                        |
| `component-extraction` | wrote **no** files (219 output tokens): asked to extract a section into its own component, it answered instead of acting |
| `ambiguous-one-word`   | built four files for the prompt `better` instead of asking what to change                                                |

An earlier run the same day scored 6/12, before `seedFiles` existed: six cases are edit-shaped, and without a seeded project they were handed an empty one and correctly built whole sites, so their failures were measuring the harness. That number is not a baseline for anything.

## Why it refuses to retry

The interesting part of an auto-fix loop is not the retry; it is every condition under which it must refuse. Enforced in `lib/validation/autofix-policy.ts`, all covered by tests:

| Condition                                                      | Behavior               | Reason                                                                                                                        |
| -------------------------------------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Check passed                                                   | stop                   | nothing to fix                                                                                                                |
| Check skipped (no module graph, no files, checker unavailable) | stop                   | absence of evidence is not evidence of a fault — a check that did not run must never trigger a rewrite                        |
| `buildAutoFixEnabled` is off                                   | stop, **but say so**   | the toggle declines to spend a generation; it does not license telling the user a broken build worked                         |
| Same failure signature as the previous attempt                 | stop                   | the model is not converging; continuing only spends credits                                                                   |
| 2 model attempts already spent                                 | stop                   | past this point the cause is usually invisible to the model                                                                   |
| Every error is a missing dependency                            | ask for supported ones | a package outside the supported set cannot be added, so that code has to change; one inside it is added with `add_dependency` |
| Anything else with a parsed error                              | re-prompt              |                                                                                                                               |

The signature deliberately excludes line numbers: an edit _above_ the fault shifts them without fixing anything, and that must not read as progress.

## Cost

The static scan is free: no bundler, no network, no database. The esbuild compile runs in-process on the generated files — hundreds of milliseconds for a generated site, no metered sandbox minutes, since there are no sandboxes any more.

A retry costs a full generation, charged through the normal `checkCredits`/`consumeCredits` path — auto-fix does not bypass credit accounting. That is what the toggle is for:

```ts
import { setBuildAutoFixEnabled } from '@/lib/validation/settings';
await setBuildAutoFixEnabled(false); // AppSetting: buildAutoFixEnabled
```

With it off, checks still run, the user is still told exactly what is broken, and the job still records a `validate-build` failure. Only the repair generation is withheld.

## Where it lives

| File                                     | Role                                                                        |
| ---------------------------------------- | --------------------------------------------------------------------------- |
| `lib/generation/validate-imports.ts`     | the static scan — pure, dependency-free, safe to run in the browser too     |
| `lib/validation/import-check.ts`         | adapts the scan to `BuildCheckResult` so one policy governs both checks     |
| `lib/validation/build-check.ts`          | the esbuild compile; parses errors, computes the failure signature          |
| `lib/validation/autofix-policy.ts`       | decides re-prompt / stop — pure, no I/O                                     |
| `lib/validation/fix-prompt.ts`           | error set → follow-up instruction, mirroring `lib/audit/fix-instruction.ts` |
| `lib/validation/run-build-validation.ts` | orchestrates the above; the route stays a thin wrapper per `AGENTS.md`      |
| `lib/validation/settings.ts`             | the admin toggle, which governs the fix and not the check                   |
| `lib/preview/resolve-bare.ts`            | the one bare-specifier verdict, shared by both bundlers                     |
| `lib/preview/deps.ts`                    | the two pinned dependency tiers and `projectPreviewDeps`                    |
| `lib/generation/tools/index.ts`          | the tool set; refusals are returned, never thrown                           |
| `lib/generation/tools/file-store.ts`     | the turn's file state; the only place a tool write becomes a file           |
| `lib/ai/agent-tools.ts`                  | reads `ai.agentTools` / `ai.maxAgentSteps`; server-side only                |

## The call site

`runBuildValidation` belongs in `app/api/generate-ai-code-stream/route.ts` after the files are parsed and before the `complete` frame, next to the existing `stackShapeMismatch` guard. The previous version of this check had **no caller at all**, which is the whole reason it could rot unnoticed — so if this snippet ever stops matching the route, the check is dead again:

```ts
const outcome = await runBuildValidation({
  stack: projectStack,
  // Merged, not just the new files: a one-file edit importing an existing
  // module would otherwise look like a broken project.
  files: { ...backendFiles, ...Object.fromEntries(files.map((f) => [f.path, f.content])) },
  changedPaths: files.map((file) => file.path),
  jobId: generationJob?.id ?? null,
  attempt: buildFixAttempt,
  previousSignature: buildFixSignature,
  notify: (message, level) => sendProgress({ type: level, message }),
});
// on the complete frame:
buildFix: outcome.retry ?? undefined,
```

The retry itself is **client-driven**, matching every other fix flow in the app (Quality, SEO): the route returns `buildFix` on the `complete` frame and `GenerationWorkspace` re-enters the queue with it, carrying `attempt` and `previousSignature` back. The server owns the policy; the client only carries the counter.

**Consequence:** the loop runs only while the tab is open. Closing it mid-fix leaves the build broken until the next edit — but the failure is recorded on the job and visible in `/admin/jobs` and the RecoveryPanel either way.

## Observability

A failure records a `validate-build` job step (`recordJobStepFailure`), so it surfaces in `/admin/jobs` and the RecoveryPanel even when the loop later repairs it. Progress reaches chat as `info`/`warning` frames — deliberately not a new SSE type, which the client's `default` case would silently drop.

## Verified

`tests/unit/validate-imports.test.ts` (24) covers the scan, including the exact `lib/data.ts` / `import { site }` failure, and a correct 15-file Next.js app that must produce zero findings. `tests/unit/validation-runs-on-generated-code.test.ts` (9) covers the wiring: the static verdict agreeing with a real esbuild compile on the same files, the repair payload, the refusals, and the toggle-off path still reporting. `tests/unit/build-autofix.test.ts` (25) covers parsing, the signature, and the policy.

`tests/unit/generation-tools.test.ts` (42) covers the tool set: every refusal returned rather than thrown, `edit_file`'s three outcomes, `search_files`' literal matching and truncation, deletion and rename bookkeeping, and `add_dependency`'s pinning. `tests/unit/generation-tool-rail.test.ts` (12) covers the client half — `applyToolFileWrite` and the two SSE handlers, which had executed zero times before it existed. `tests/unit/starter-kit-renders.test.ts` covers the missing-package triple: the import that used to compile clean now fails with `kind: 'missing-package'`, the same import passes once declared, and `decideAutoFix` reaches its previously dead `install` branch. Deletions are proved against a real database in `tests/integration/settle-streamed-generation.test.ts`.

Not covered by tests: nothing here needs a sandbox or a provider key any more, so there is no remaining "not verified end-to-end" caveat for the checks themselves. What is not covered is the hand-off — the route passing `buildFix` on the `complete` frame and the client carrying `attempt`/`previousSignature` back; that lives in the route and `GenerationWorkspace`.
