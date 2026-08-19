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

Bare specifiers (`react`, `next/image`, `lucide-react`) are skipped: whether a package is available is answered by `lib/preview/deps.ts`, and guessing here would flag the `next/*` modules the preview shims.

**False positives are the failure mode that matters.** A wrong "invalid" verdict blocks a working build and spends a generation rewriting correct code, so the scanner passes whenever it is unsure:

- it is a scanner, not a parser — no parser is a dependency of this path — and the module comment lists what it deliberately does not understand;
- CommonJS, an unreadable `export *`, or a re-export chain deeper than four hops makes the target's export set _open_, and an unknown export set can never contradict an import;
- before any missing-export claim, `mentionsSymbol` checks whether the name appears in the target at all. If `lib/data.ts` contains the token `site` anywhere, the likelier reading is that the scanner missed an export form. Word-bounded, so `siteConfig` does not vouch for `site` — the exact shape of the incident.

Problems are reported only for the files the run generated (`changedPaths`); a pre-existing problem in an untouched file is not this build's fault.

### 2. The esbuild bundle

`checkBuild` compiles the assembled project with `buildStaticSite` — the same esbuild pass as the preview. It also catches syntax and JSX errors, and it runs in-process, so there is no VM to be absent. When the static scan has already found something, the bundle is skipped: it would fail on the same import, and the static message names the file and the symbol in plainer English than esbuild does.

## Why it refuses to retry

The interesting part of an auto-fix loop is not the retry; it is every condition under which it must refuse. Enforced in `lib/validation/autofix-policy.ts`, all covered by tests:

| Condition                                                      | Behavior               | Reason                                                                                                 |
| -------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------ |
| Check passed                                                   | stop                   | nothing to fix                                                                                         |
| Check skipped (no module graph, no files, checker unavailable) | stop                   | absence of evidence is not evidence of a fault — a check that did not run must never trigger a rewrite |
| `buildAutoFixEnabled` is off                                   | stop, **but say so**   | the toggle declines to spend a generation; it does not license telling the user a broken build worked  |
| Same failure signature as the previous attempt                 | stop                   | the model is not converging; continuing only spends credits                                            |
| 2 model attempts already spent                                 | stop                   | past this point the cause is usually invisible to the model                                            |
| Every error is a missing dependency                            | ask for supported ones | nothing is installable — preview dependencies resolve from esm.sh — so the code has to change          |
| Anything else with a parsed error                              | re-prompt              |                                                                                                        |

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

Not covered by tests: nothing here needs a sandbox or a provider key any more, so there is no remaining "not verified end-to-end" caveat for the checks themselves. What is not covered is the hand-off — the route passing `buildFix` on the `complete` frame and the client carrying `attempt`/`previousSignature` back; that lives in the route and `GenerationWorkspace`.
