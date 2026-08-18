# Build auto-fix loop

Closes the gap named in [docs/codegen-vs-open-lovable.md](./codegen-vs-open-lovable.md): until now nothing checked whether generated code actually compiles. A syntax error ended as *"applied successfully"* with a blank preview, and the user had to notice and report it themselves.

Neither this repo nor upstream open-lovable had this. `lib/build-validator.ts` carried the intent but was orphaned — zero importers — and was Vite-only, so it would have passed every broken NEXTJS build. It has been deleted and replaced by `lib/validation/`.

## The loop

```
apply files → run the stack's build command
                  ├─ passes                → done
                  ├─ only missing packages → install, re-check
                  └─ code error            → re-prompt the model → re-apply → re-check
                                              (max 2 model attempts)
```

## Why the build command

It is the one signal that generalizes. The previous approach fetched the preview HTML and looked for `vite-error-overlay` and `id="root"` — markers only REACT produces, so NEXTJS (the default stack) would report a false pass on every broken build. Running `getStack(stack).buildCommand` is what actually has to succeed, and it fails loudly with a parseable error.

`STATIC_HTML` has no build command and is skipped — there is nothing that can fail to compile.

## Why it refuses to retry

The interesting part of an auto-fix loop is not the retry; it is every condition under which it must refuse. Each of these is enforced in `lib/validation/autofix-policy.ts` and covered by tests:

| Condition | Behavior | Reason |
|---|---|---|
| Build passed | stop | nothing to fix |
| Check skipped (no build command, no sandbox, sandbox threw) | stop | absence of evidence is not evidence of a fault — an infrastructure blip must never trigger a code rewrite |
| Same failure signature as the previous attempt | stop | the model is not converging; continuing only spends credits |
| 2 model attempts already spent | stop | past this point the cause is usually invisible to the model |
| Every error is a missing dependency | install, then re-check | cheaper and more reliable than asking a model to rewrite imports it believes are correct |
| Anything else with a parsed error | re-prompt | |

The signature deliberately excludes line numbers: an edit *above* the fault shifts them without fixing anything, and that must not read as progress.

## Cost — read this before enabling

Validation runs the stack's real production build after **every apply**, including a one-word copy change. That costs wall-clock time and metered sandbox minutes. A retry additionally costs a full generation, charged through the normal `checkCredits`/`consumeCredits` path — auto-fix does not bypass credit accounting.

It is on by default (a site that does not compile is worse than one that took longer), and off in one click:

```ts
import { setBuildAutoFixEnabled } from '@/lib/validation/settings';
await setBuildAutoFixEnabled(false); // AppSetting: buildAutoFixEnabled
```

If the wall-clock cost proves too high in practice, the cheaper option is `runTypescriptCheck` (`lib/audit/static/typescript.ts`) — faster, catches most real breakage, misses bundler-level failures.

## Where it lives

| File | Role |
|---|---|
| `lib/validation/build-check.ts` | runs the build, parses errors, computes the failure signature |
| `lib/validation/autofix-policy.ts` | decides retry / install / stop — pure, no I/O |
| `lib/validation/fix-prompt.ts` | error set → follow-up instruction, mirroring `lib/audit/fix-instruction.ts` |
| `lib/validation/run-build-validation.ts` | orchestrates the above; the route stays a thin wrapper per `AGENTS.md` |
| `lib/validation/settings.ts` | the admin toggle |

The retry itself is **client-driven**, matching every other fix flow in the app (Quality, SEO). Generation in this codebase runs from the browser via `executeGenerationJob`; `startFollowUpGeneration` in `lib/projects/plan.ts` only writes an analytics event despite its name. The apply route returns a `buildFix` payload on the `complete` frame and `GenerationWorkspace.applyGeneratedCode` re-enters the queue with it. The server owns the policy; the client only carries the attempt counter back.

**Consequence:** the loop runs only while the tab is open. Closing it mid-fix leaves the build broken until the next edit. Making it survive that requires extracting a callable `runGeneration()` out of the 2,286-line generate route, which is a separate change.

## Observability

A failing build records a `validate-build` job step (`recordJobStepFailure`), so it surfaces in `/admin/jobs` and the RecoveryPanel even when the loop later repairs it. Progress reaches chat as `info`/`warning` frames — deliberately not a new SSE type, which the client's `default` case would silently drop.

## Not verified end-to-end

The parsing, policy, and prompt construction are covered by 24 unit tests. The loop has **not** been run against a live sandbox — that needs provider API keys and a booted E2B/Daytona instance. The fixtures use real Next.js and webpack error output, but the first live run should be watched.
