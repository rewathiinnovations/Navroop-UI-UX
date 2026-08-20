# Decisions needed before the blocked waves start

11 decisions, 27 findings blocked on them. Everything else proceeds in parallel and is not
waiting on you. Each item: what is blocked, the options with their real cost, my recommendation.
Answer inline under **Answer:** — I read this file back before starting each blocked group.

---

## D1 — How should generated previews be isolated? (F-140 CRITICAL, blocks G08, 14 findings)

**What is true today.** `previewStaticBaseUrl()` (`lib/preview/url.ts:15-16`) falls back to the
application's own origin when no Cloudflare zone is connected. `previewResponseHeaders`
(`lib/preview/headers.ts:8`) sends `default-src 'self' 'unsafe-inline' 'unsafe-eval'`. The in-app
iframe is correctly sandboxed without `allow-same-origin` (`BrowserPreview.tsx:388`) — but
"Open in new tab" calls `window.open(url, '_blank')` (`lib/preview/devices.ts:81-87`), which is
top-level, first-party, and carries session cookies. So model-authored JavaScript can call
`/api/*` as the signed-in user. On this deployment there is no connected zone, so the fallback
is the live path.

| Option                                                                                                              | Cost                                                                                                    | Residual risk                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **A. Require a connected Cloudflare zone; refuse to serve previews without one**                                    | Infra prerequisite; previews stop working on installs with no zone (including this one) until connected | None — different origin always                                                                                             |
| **B. Serve previews from a second hostname on the same app** (`preview.<host>`, or a `*.preview` wildcard)          | One DNS record + one env/setting; cheap                                                                 | Sibling origin, so cookies must be scoped to the app host — verify `SameSite`/domain on the Auth.js cookie                 |
| **C. Keep the origin, but never open top-level**: remove `window.open`, keep only the sandboxed iframe, tighten CSP | Cheapest; costs the "open in new tab" affordance and the Mobile-view popup                              | Same-origin content still reachable if any other path renders it outside the sandbox; one future mistake re-opens the hole |
| **D. Signed one-time redirect to a `blob:`/`data:` origin**                                                         | Complex, breaks multi-page routing (already broken per F-145)                                           | Opaque origin is safe, but this fights the product                                                                         |

**Recommendation: B, with C's CSP tightening applied regardless.** B removes the class of bug
instead of the instance, costs one DNS record, and keeps the feature. C alone leaves the
same-origin content in place for the next caller to expose. A is the strictest but degrades a
working install to broken, which you will not accept in a product that ships without a zone.

**Answer:B, with C's CSP tightening applied regardless**

---

## D2 — Encrypting provider API keys: re-encrypt in place, or invalidate and re-enter? (F-300/F-070, F-071, F-715 — blocks G07, 14 findings)

**What is true today, and it is not what the audit assumed.** No schema change is needed:
`ApiKey.secret` / `OrgApiKey.secret` are `String` and the _read_ path already tries to decrypt
(`lib/api-keys.ts:65-72`). Only the write path stores plaintext
(`lib/api-keys/actions.ts:86,89,119,120`). So this is a data backfill, not a migration.

**The blocker I found while grounding this.** `lib/crypto.ts:17-23` produces a bare
`base64(iv||tag||ciphertext)` with **no version prefix**. There is therefore no way to tell
"legacy plaintext" from "encrypted under a key I no longer have" — both fail identically, which
is precisely why F-071 hands the ciphertext back as an API key. And `getKey()` falls back to
`AUTH_SECRET` (F-715), so anything encrypted today becomes undecryptable the day someone adds
`ENCRYPTION_KEY`. **These three must land as one change** or the backfill is a future outage.

The only genuine choice is what happens to the keys that are currently plaintext in the database:

| Option                                                                          | Cost                                                                                                        | Residual risk                                                                                                                                                        |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Re-encrypt in place** (one-time script, prefixed envelope, no user action) | Zero user friction                                                                                          | The plaintext values existed in the DB, in every dump taken since, and — for two of them — in this session's transcript. If any dump leaked, the keys are still live |
| **B. Invalidate: drop the rows, require re-entry in Admin → Configuration**     | Every user with a personal key and the org key must paste it again; generation fails for them until they do | None for the old values                                                                                                                                              |
| **C. Re-encrypt now, rotate at the vendor on your own schedule**                | Same as A plus your rotation work                                                                           | Bounded by how fast you rotate                                                                                                                                       |

**Recommendation: C.** Encrypt in place so nothing breaks, prefix the envelope (`enc:v1:`), make
a prefixed-but-undecryptable value a hard error, forbid the `AUTH_SECRET` fallback when
`ENCRYPTION_KEY` is absent at boot — then rotate the vendor keys yourself. You already need to
rotate two of them (D7), so the rotation work exists either way.

**Answer:C.**

---

## D3 — What should publish do when the target repo already exists? (F-202 CRITICAL, blocks 2 of G09)

`lib/github/deploy-client.ts:162-196,213-250` force-pushes. A project slug that collides with an
existing organisation repository overwrites it.

| Option                                                                                                         | Cost                                                                                                 | Notes                                                            |
| -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| **A. Refuse unless this project created it** (record the repo id on first publish, compare on every later one) | One column or a `resourceIds` entry; a clear error the user can act on                               | Safest; needs a story for repos created before the column exists |
| **B. Suffix the slug until free** (`site`, `site-2`, …)                                                        | No failure path, but the published URL silently differs from the one the UI promised (already F-244) | Surprising, and the URL is user-visible                          |
| **C. Require explicit overwrite confirmation in the Publish sheet**                                            | UI work; a confirmation is only as good as the person reading it                                     | Keeps a legitimate "yes, replace it" path                        |

**Recommendation: A, with C as the escape hatch** — refuse by default, and offer "replace the
existing repository" only when the user typed the repo name, using the existing `ConfirmAction`
`confirmPhrase` mechanism rather than a new dialog.

**Answer:A, with C as the escape hatch**

---

## D4 — `packages/create-open-lovable/`: wire it in, or delete it? (F-841, F-720 — blocks 2 of G02)

Zero references outside itself; `pnpm-workspace.yaml` has no `packages:` key and root
`package.json` has no `workspaces`, so pnpm never installs its deps or links its bin — it cannot
run from this checkout. Its content is built around the deleted sandbox subsystem, and its
installer recursively deletes a user-named directory and writes plaintext keys (F-720).

| Option                                    | Cost                                                                                                             | Notes                                                    |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| **A. Delete**                             | Nothing to maintain; loses a scaffolding CLI nobody can currently run                                            | ~40 files gone                                           |
| **B. Wire into the workspace and fix it** | Real work: workspace entry, sandbox references removed, the `rm -rf` and plaintext-key defects fixed, plus tests | Only worth it if you want to ship a public `create-` CLI |

**Recommendation: A, delete.** It is dead, it is built on a subsystem you removed, and its
installer is the most dangerous code in the repository. If you want the CLI later it is one
`git revert` away.

**Answer:A, delete.**

---

## D5 — Quality signals: fix the scoring, or hide the scores? (F-705, F-760, F-816 — blocks 3 of G15)

Three of the composite metrics are not measuring anything. `type_safety` is collected and shown
but carries no weight (F-760); every a11y violation is scored "moderate" because the production
caller drops the impact (F-816); and four checks report "could not run" while the signal writer
records a perfect 1.0 (F-705). `/admin/quality` presents this as data.

| Option                                                                                                           | Cost                                                   | Notes                                    |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ---------------------------------------- |
| **A. Fix the pipeline** (route the "could not run" verdict to the score, weight `type_safety`, keep axe impacts) | Moderate; F-705 is a category mismatch, not a redesign | The dashboard becomes true               |
| **B. Hide the three broken metrics until fixed**                                                                 | Small; the page shows fewer, honest numbers            | Leaves the collectors writing wrong rows |
| **C. Both — hide now, fix in Wave 4**                                                                            | Two changes                                            | Honest immediately, correct later        |

**Recommendation: C.** Nobody should be making decisions off a fabricated 1.0 while the fix
waits its turn, and the fix is not a one-liner.

**Answer:C.**

---

## D6 — Password-protected preview deploys: keep and document, or remove? (F-543, F-231, F-232 — blocks 3 of G09/G22)

A whole feature — `PREVIEW_PASSWORD`, injected middleware, `Deployment.passwordHash`,
`/api/projects/[id]/publish/password` — documented nowhere. It also has real defects: a
non-constant-time compare, an ignored username, no rollback if the re-publish fails (F-231), and
setting a password runs a full publish inline in a server action with no lock (F-232).

| Option                     | Cost                                                                                                  | Notes                                          |
| -------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| **A. Keep, fix, document** | Fix the compare, add the rollback, move the publish into the PUBLISH job, write the AGENTS.md section | It is a reasonable feature for client previews |
| **B. Remove**              | Deletes a shipped capability someone may be using; needs a migration for `passwordHash`               | Smaller surface                                |

**Recommendation: A.** It is a sensible feature for an agency product showing client previews,
and the defects are ordinary. But if nobody uses it, say so and I will remove it — that is
cheaper than maintaining it.

**Answer:A.**

---

## D7 — Live credentials in `.env` / `.env.local` (F-714 HIGH — blocked on you, not me)

`.env.local` and `.env` hold live third-party credentials including a Coolify API token that this
repo's own always-on rule prohibits writing down. Separately, two credentials (an Unsplash secret
key and the image-worker bearer token) were pasted as plain text into an earlier chat in this
session and are therefore in the transcript.

I cannot rotate these — they live at the vendors. **What I can do:** move every one of them out
of `.env*` into Admin → Configuration (encrypted, per the admin-settings-over-env rule), and
leave `.env.example` documenting only the required infra vars.

**Recommendation:** rotate the Coolify token, the Unsplash secret and the image-worker token at
the vendor, then paste the new values into Admin → Configuration rather than `.env`. Tell me when
that is done and I will strip the `.env*` entries in the same commit as the registry work.

**Answer:I agree with Recommendation**

---

## D8 — Schema changes that need a migration (F-309, F-310, F-311, F-314, F-351, F-360, F-362, F-363 — blocks 8 in G18/G27)

Eight findings need Prisma migrations, and they are not all equally safe:

| Finding      | Change                                                                                                                                | Destructive?            |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| F-314, F-363 | add composite indexes on hot list queries + `CreditLedger.projectId`                                                                  | No                      |
| F-309, F-352 | represent the four database-only invariants (last-admin trigger, atomic consume, ON DELETE RESTRICT) in the schema or a runtime check | No                      |
| F-351        | `Invite` cannot express a pending invitation — add state                                                                              | No                      |
| F-310        | a user can never be hard-deleted; last-admin trigger does not cover DELETE                                                            | Trigger change          |
| F-360, F-362 | `AppSetting` is four stores in one table; three history tables have no retention                                                      | **Yes** if split/pruned |

**Recommendation:** approve the non-destructive set (F-314, F-363, F-309, F-352, F-351) for Wave 4
as one migration. Defer F-310, F-360 and F-362 — they are design changes, not fixes, and F-360 in
particular is a table split that wants its own change with a backfill.

**Answer:go with Recommendation**

---

## D9 — Morph Fast Apply: implement or remove? (F-718 HIGH — blocks 1 in G02)

A configurable, keyed, billable feature with no applier — and its writer is shell-injectable.

**Recommendation: remove.** Keeping a billable integration that cannot apply anything is strictly
worse than not having it; the shell-injection surface is the argument for doing it now.

**Answer:remove.**

---

## D10 — Dead user-facing surfaces (F-402, F-545 — blocks 2, and gates the rest of G02)

- **F-402** "Starred projects": the filter, the query and the badge exist; nothing can star a project.
- **F-545** `/builder`: an orphaned mock page that fabricates a fake generated site.

Plus the wider sweep in `G02-dead-code-sweep` (27 findings, ~1,400+ lines): the sandbox-era
generation modules behind the unwritten `global.sandboxState`, the disconnected `buildFix` loop,
the package-detection UI with no installer, eight unwired `verify-*` scripts.

**Recommendation:** delete `/builder`; either build the star action (small — one mutation and a
button) or remove the starred UI; approve the G02 sweep as **one reviewable commit per
subsystem**, not one giant deletion. Deleting code is the one thing I will not do on my own
initiative, so this needs your yes.

**Answer:go withj Recommendation**

---

## D11 — Which GAP items should be built at all? (43 GAP findings, Wave 6)

GAPs are missing capability, not defects. Building them is new work and your call. The ones I
would argue for, in order:

1. **F-350 CSRF token on cookie-authenticated state-changing routes** — the only GAP I would call
   a security hole rather than a missing feature.
2. **F-260 / F-263** a failed deployment tells the user nothing, and the owner is never told a
   custom domain failed. Cheap, and both are "the product went quiet" complaints.
3. **F-784** dead-man's switch for the digest that reports every other cron — today its own
   silence is indistinguishable from health.
4. **F-172 / F-781** nothing detects or acts on orphaned storage objects; storage grows forever.
5. **F-445** no `loading.tsx` / `not-found.tsx` / per-segment `error.tsx` anywhere in `app/`.

The rest (attachments F-091, stream resume F-092, deployment rollback F-264, webhook verification
F-265, offline handling F-446, the eight test-coverage GAPs) I would leave filed and unbuilt
unless you want them.

**Answer:Build all**
