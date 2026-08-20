# Phase 3 — Deployment (G) and Git push (H)

Scope: `audit/_scope-p3.txt` (94 files, 8,769 lines). Every file was read in full; the
ledger at the end records a verdict per file. Finding ids **F-200 … F-299**.

Read first: `AGENTS.md`, `.cursor/lessons-learned.md`, `audit/00-map.md`. No application
file was modified.

## How the deploy path actually works (from the code)

`startPublish` (`lib/publish/actions.ts:116`) or `POST /api/projects/[id]/publish`
(`app/api/projects/[id]/publish/route.ts:40`) → gate on integrations + plan slot + project
lock → `after()` → `startPublishJob` (`lib/publish/publish.ts:59`) creates/reuses a
`PUBLISH` Job and the `Deployment` row → `runPublishJob` (`lib/publish/execute.ts:203`)
walks ten steps (`lib/publish/steps.ts:1`): `limit, files, slug, github, app, dns, domain,
deploy, poll, live`. Each step persists `Job.steps` + `Deployment.status/progressStep`
through `persistProgress` (`execute.ts:139`). The UI polls the job.

Files come from the latest `Checkpoint` snapshot, else `Project.lastCode`
(`lib/publish/files.ts:27`). They are committed as **one tree with inline content and no
`base_tree`**, then `main` is **force-moved** (`lib/github/deploy-client.ts:216-250`).
Coolify creates the app (`lib/coolify/client.ts:299`), Cloudflare gets a proxied A record
(`lib/cloudflare/dns.ts:71`), the hostname is merged onto the app
(`client.ts:427`) and primary/alias 301s are re-asserted (`lib/domains/redirects.ts:14`).

Compensation on abandon is as documented: first-time publish rolls everything back,
re-publish rolls back nothing (`lib/jobs/compensate.ts:16`, `:90-99`, `:114-142`) — that
rule is implemented correctly. The gap is in what happens to the `Deployment` row
afterwards (F-205).

## Environment variables in scope

| Var                               | Read at                                                                                                      | Correct classification         | Verdict                                                                                                                   |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `PREVIEW_PASSWORD`                | `lib/publish/preview-inject.ts:86` — inside the **generated project's** middleware, on its Coolify container | Runtime (of the deployed site) | Correct. Written to the Coolify app by `updatePreviewPassword` (`lib/publish/publish.ts:210`); never in Navroop's own env |
| `AUTH_SECRET` / `NEXTAUTH_SECRET` | `lib/github/oauth-state.ts:7`                                                                                | Runtime, server-only           | Correct — server-only, no `NEXT_PUBLIC_`, throws when absent (`:26`)                                                      |
| `NODE_ENV`                        | `oauth-state.ts:17`, `sentry-persist.ts:13,55`, `sentry.ts:193`, `sentry-oauth.ts:344`                       | Build-time + runtime           | Correct usage                                                                                                             |
| `NEXT_PUBLIC_WORKSPACE_NAME`      | `lib/integrations/sentry-oauth.ts:324`, `app/api/integrations/github/start/route.ts:17`                      | **Build-time inlined**         | Misclassified in practice — see F-240                                                                                     |

**No secret in these 94 files can be inlined into a client bundle.** The only
`NEXT_PUBLIC_*` read is the workspace name. Every credential path goes through
`lib/integrations/secrets.ts` (AES-256-GCM via `lib/crypto`) or `lib/coolify/servers.ts`,
and the two client files in scope (`DeploymentsList.tsx`, `connectors/page.tsx`) receive
only serialised props. `serializeDeployment` (`lib/publish/serialize.ts:26`) never emits a
token — but it does emit `lastError` verbatim, which is how F-208 and F-229 leak.

---

### F-200 [HIGH] Publish ships the checkpoint files raw — no scaffold, no Dockerfile, no package.json

- Area: G
- Location: lib/publish/execute.ts:293-310 (`collectForPublish`), lib/publish/files.ts:27-51, lib/deploy/repo-files.ts:16-46, lib/stacks.ts:98-103
- What happens: `collectForPublish` calls only `collectPublishFiles`, which returns the latest checkpoint snapshot. Checkpoint snapshots are `captureFileSnapshot` output (`lib/checkpoints/actions.ts:131` → `lib/checkpoints/snapshot.ts:15-24` → `getCurrentProjectFiles`), i.e. the AI-generated `<file>` blocks from `Project.lastCode` and nothing else. `buildRepoFiles` — which lays the stack scaffold underneath and adds `Dockerfile`, `.dockerignore`, `.gitignore`, `README.md`, and a named `package.json` (`lib/deploy/repo-files.ts:26-43`) — is called by the Connectors push (`lib/github/push.ts:139`) and by ZIP export (`app/api/projects/[id]/export/route.ts:77`), but **never by publish**. Meanwhile every stack has `dockerfile: null` (`lib/stacks.ts:102,135,160`), so `createApplication` picks `nixpacks` for NEXTJS/REACT (`lib/coolify/client.ts:308-312`) — a build pack that needs a `package.json` in the repo root.
- Trigger: publish any NEXTJS or REACT project whose generation did not happen to emit `package.json` (the scaffold normally provides it, and the scaffold is not in the snapshot).
- Impact: the Coolify build fails at `poll` after up to ten minutes with a raw Coolify message, on the one path that costs the user a live slot. Where it does build, it builds without the explicit Dockerfile the codebase was written to ship (`tests/unit/deploy-repo-files.test.ts:25-34` states the intent: "ships a Dockerfile per stack so Coolify needs no configuration"). Publish, push, and export are three copies of "make a repo" and only publish drifted.
- Confidence: Confirmed (code paths), Likely for the failure rate (depends on what a given generation emitted)
- Suggested fix: route publish's file collection through `buildRepoFiles` with the project's stack and name, exactly as export and push do. Keep the preview injection on top of that result. Then delete the duplicate "which files make a repo" knowledge from the three call sites so it cannot drift again.

### F-201 [HIGH] Nothing excludes `.env` from the deploy repo, and the `.gitignore` the product writes cannot help

- Area: G / H
- Location: lib/publish/files.ts:10-18 (`toMap`), lib/github/deploy-client.ts:208, lib/deploy/repo-files.ts:39-40
- What happens: `toMap` strips only a leading `./` and paths under `.git/`; `pushFiles` filters only `.git/` again. Any `.env`, `.env.local`, `.env.production`, key file, or credential file present in the snapshot is committed to the deploy repo. `buildRepoFiles` does write a `.gitignore` containing `node_modules`, `.next`, `dist`, `.env`, `.env.local` (`repo-files.ts:39-40`) — but publish never ships it (F-200), **and a `.gitignore` has no effect on a Git Data trees API commit anyway**: `pushFiles` posts explicit tree entries, so `.gitignore` is decoration.
- Trigger: a generation (or a follow-up, or a URL import) writes an `.env`-style file containing an API key, then the user publishes.
- Impact: the secret lands in a GitHub repository under the deploy org, in git history, and is then checked out into a Coolify build. The repo is private, but the blast radius is everyone with org read access plus the archived copy compensation leaves behind (`lib/jobs/compensate.ts:137` archives rather than deletes). ZIP export and the Connectors push at least attach an ignore file; the publish path has no filter of any kind.
- Confidence: Confirmed
- Suggested fix: put one explicit deny list in front of every path that turns project files into a commit or an archive — `.env*`, `node_modules/**`, `.git/**`, build output, plus a per-file size ceiling — and make the trees builder consume it rather than relying on `.gitignore`. Fail the publish loudly when a denied path is present rather than silently dropping it, so the user learns the generation wrote a secret.

### F-202 [CRITICAL] A slug that matches an existing org repo makes publish force-push over that repo

- Area: H
- Location: lib/github/deploy-client.ts:162-196 (`ensureDeployRepo`), :213-250 (`pushFiles`), lib/publish/naming.ts:22-24, lib/integrations/github-manifest.ts:24-28
- What happens: `deployRepoName` for LIVE is the bare slug (`naming.ts:23`), and slugs come from the project name (`lib/publish/slug.ts:21-31`). `ensureDeployRepo` does `GET /repos/{org}/{slug}` and, if it exists, **adopts it** and returns its `full_name` (`deploy-client.ts:166-169`) — there is no check that this system created it. `pushFiles` then builds a tree with **no `base_tree`** (`:216-226`), so the tree contains only the project's files, and moves `refs/heads/main` with `force: true` (`:243-250`). The deploy App holds `contents: write` and `administration: write` across the installation (`github-manifest.ts:24-28`).
- Trigger: the deploy org already contains a repo named e.g. `acme` (a real product repo, or a repo an operator created by hand); a user names a project "Acme" and publishes LIVE.
- Impact: `main` in that unrelated repository is replaced by the generated site in a single commit and the previous tip is only reachable via reflog/GitHub's dangling-commit API. This is silent, irreversible-from-the-product data loss in a repo the product does not own. `naming.ts:11-16` already documents that reaping _by name shape_ destroyed operators' DNS records; the same "a LIVE name is an indistinguishable bare slug" mistake is still live on the write path.
- Confidence: Confirmed
- Suggested fix: never adopt a repo by name. Record the repo id (not just `full_name`) on the `Deployment` row the first time this system creates it, and refuse to push to a repo whose recorded id does not match. Give deploy repos a reserved prefix so a collision with a human repo is impossible, and stop force-pushing — push a normal fast-forward commit whose parent is the ref this system last wrote.

### F-203 [HIGH] Double-clicking Publish runs two concurrent runners over the same job

- Area: G
- Location: lib/publish/execute.ts:203-207, lib/publish/publish.ts:75-84, lib/projects/lock.ts:199 and :219-224, lib/jobs/lifecycle.ts:260-275
- What happens: nothing claims a run. `runPublishJob` returns early only for `SUCCEEDED` or a terminal status (`execute.ts:206-207`) — a `RUNNING` job is executed again. The three would-be guards all pass: `acquireLock` is **re-entrant for the same user** (documented at `lock.ts:199`), so the second request gets `reentered: true, release: releaseNothing` (`:224`); `startPublishJob` sees the active PUBLISH job and hands back the _same_ `jobId` (`publish.ts:76-82`); and `markJobRunning`'s conditional write uses `WHERE status IN ('QUEUED','RUNNING')` (`lifecycle.ts:260`), so a second `RUNNING` write succeeds. Each runner holds its own local `steps` array (`execute.ts:216`) and its own `resourceIds` snapshot (`:217`), so the "skip succeeded step" check (`:241`) and the `if (resourceIds.coolifyAppUuid) return` guard (`:370`) are per-runner.
- Trigger: click Publish twice, or open the project in two tabs and publish from both, or POST `/api/projects/[id]/publish` twice.
- Impact: two force-pushes racing on the same branch, two `triggerDeploy` calls, interleaved writes to one `Job.steps` and one `Deployment` row (last writer wins, so the stepper can go backwards), and — if both reach the `app` step before either's `findApplicationByName` sees the other's app — two Coolify applications for one deployment, one of which is recorded nowhere and therefore unreapable (`lib/publish/cleanup.ts:154-162` explains why that matters).
- Confidence: Confirmed
- Suggested fix: make the runner claim the job with a conditional write that only a `QUEUED` row (or a row whose `ownerInstance` is dead) can win, and return the existing run otherwise — the same "win is the UPDATE row count" discipline the terminal transitions already use. The publish entry points should return the in-flight job to the second caller instead of starting a second runner.

### F-204 [HIGH] The poll step reads application health, not the deployment it triggered

- Area: G
- Location: lib/publish/execute.ts:437-454, lib/coolify/client.ts:357-371 (`triggerDeploy`), :374-399 (`getDeploymentStatus`)
- What happens: `triggerDeploy` returns a `deploymentUuid` and `execute.ts:433` stores it as `lastRequestId` — then throws the correlation away. `getDeploymentStatus` ignores it and reads `GET /api/v1/applications/{appUuid}`, deriving health from the **application's** current status string. On a re-publish the application is already `running:healthy` from the previous build, so the very first poll returns `healthy` and the loop breaks immediately.
- Trigger: publish a project that already has a LIVE deployment (any re-publish, any Redeploy from `/deployments`, any preview password change on a node stack).
- Impact: the `live` step writes `status: LIVE`, a fresh `publishedAt`, `lastError: null` and the job succeeds while the new build is still running — or after it has already failed. The user is told the new version is live and sees the old one. The build-failed branch (`:446`) can never fire for a re-publish. A user chasing "my change isn't showing" has no signal at all.
- Confidence: Confirmed
- Suggested fix: poll the deployment, not the application — carry the `deploymentUuid` from `triggerDeploy` into the poll and read that deployment's terminal state, falling back to comparing the application's deployed commit against the `commitSha` this job pushed. Treat "no deployment uuid returned" as a failure to verify rather than as success.

### F-205 [HIGH] An abandoned re-publish leaves the Deployment stuck on BUILDING forever

- Area: G
- Location: lib/jobs/compensate-publish.ts:73-83, lib/publish/execute.ts:128-137 (`deriveDeploymentStatus`), lib/publish/publish.ts:110
- What happens: a re-publish starts with the row kept at `LIVE` (`publish.ts:110`), then the first `persistProgress` writes `deriveDeploymentStatus('RUNNING', true)` → `BUILDING`. If the job is abandoned rather than failed — instance restart, SIGTERM drain, stale heartbeat — `runPublishJob`'s catch never runs, so `markDeploymentFailed` never runs. `compensateAbandonedPublish` correctly rolls nothing back for a re-publish, but its status write is gated on `result.rolledBack` (`compensate-publish.ts:73`), which is false in exactly that case. No other writer exists: the only `deployment.update` calls in the repo are in `execute.ts`, `publish.ts`, `cleanup.ts` (STOPPED) and this one.
- Trigger: deploy Navroop (or let Coolify restart it) while any re-publish is between its first and last step.
- Impact: the site is live and healthy, and the product says "Building" forever — in the publish sheet, on `/deployments`, on the project badge. There is no user action that clears it except publishing again and hoping the next one survives. The row also keeps consuming the plan slot (`lib/publish/limits.ts:35` treats any non-STOPPED row as occupying it).
- Confidence: Confirmed
- Suggested fix: settle the `Deployment` row on every abandon, not only on rollback. For a re-publish that means restoring the state the row had before the job started (`LIVE`, with `lastError` naming the interrupted attempt); `deriveDeploymentStatus('ABANDONED', true)` already computes the right answer and simply has no caller.

### F-206 [HIGH] One member's expired personal GitHub token marks the org-wide deploy integration ERROR

- Area: H
- Location: lib/github/push.ts:32-46 (`noteGitHubAuthFailure`), :156, :169; lib/integrations/messages.ts:11-16
- What happens: the Connectors push uses a **per-user OAuth token** (`decryptCallerAccessToken`, `push.ts:126`). When GitHub rejects it, `noteGitHubAuthFailure` writes `status: 'ERROR'` onto the `GITHUB_DEPLOY` integration — the row that holds the **GitHub App** credentials for publishing, which are unrelated to that user's token. `missingIntegrationKinds` counts only `CONNECTED` (`messages.ts:12-15`), so publish is immediately blocked workspace-wide with "GitHub is not connected".
- Trigger: any member revokes, or lets expire, their personal GitHub authorisation and clicks "Push to GitHub".
- Impact: publishing stops for every user until an admin re-runs the GitHub App connect flow or the daily health cron flips the row back (`lib/integrations/health.ts:92`). The error message tells the admin to reconnect the App, which was never broken.
- Confidence: Confirmed
- Suggested fix: record a personal-connection failure on that user's `GitHubConnection` row (a `lastError` / `revokedAt` column), and surface it on `/connectors` for that user only. The deploy App's status may only be written by checks that actually exercise the App's credentials.

### F-207 [HIGH] A domain change while Cloudflare is not CONNECTED strips the site's own hostname off the app

- Area: G
- Location: lib/domains/redirects.ts:14-39, lib/coolify/client.ts:463-484 (`setApplicationPrimaryRedirects`), lib/integrations/store.ts:215-218 (`peekRootDomain`)
- What happens: `setApplicationPrimaryRedirects` **replaces** the application's whole `domains`/`fqdn` list with `primary` plus the aliases it is handed. `applyPrimaryRedirects` builds those aliases from `peekRootDomain`, which returns `null` unless the Cloudflare integration is `CONNECTED` (`store.ts:216` → `requireConnected`). With `zone === null` the publish hostname `{slug}.{zone}` is never added (`redirects.ts:26`), so the PATCH removes it.
- Trigger: Cloudflare is DISCONNECTED, PENDING (which the connect wizard sets whenever a token maps to several zones — `lib/integrations/cloudflare-connect.ts:113-121`) or ERROR, and then any of: the domain cron verifies a custom domain (`verify.ts:169`), a user sets a primary domain (`actions.ts:122`), a user removes a primary domain (`actions.ts:171`).
- Impact: the published site's canonical URL stops resolving on Coolify — a live customer site goes down as a side effect of an unrelated Cloudflare state, from a cron with nobody watching. Note this is the mirror image of the bug `execute.ts:65-70` was written to prevent; the read-modify-write discipline applied to `addApplicationDomain` was not applied here.
- Confidence: Confirmed
- Suggested fix: `applyPrimaryRedirects` must refuse to write when it cannot enumerate every hostname that should stay attached — read the current `fqdn` list and preserve unknown entries instead of reconstructing the list from partial state. Treat "root domain unknown" as an abort with a recorded reason, not as an empty alias set.

### F-208 [HIGH] The domain verify token leaks to read-only viewers through `lastError`

- Area: G
- Location: lib/domains/errors.ts:13-14, lib/domains/verify.ts:71-80 and :112-116, lib/domains/instructions.ts:104-110 (`withoutVerifyToken`), lib/domains/list.ts:33
- What happens: `formatRecordMismatch` builds `TXT _navroop-verify.host is missing; expected <verifyToken>` and `checkDomain` persists that string into `CustomDomain.lastError`. `getProjectDomainState` strips the token for a viewer who cannot mutate — but `withoutVerifyToken` only blanks the `verifyToken` field and filters the instruction rows; it never touches `lastError`, which is returned verbatim in the same payload.
- Trigger: any signed-in member opens `/api/projects/{someoneElsesProject}/domains` (project reads are workspace-wide by design) for a project with a pending domain — the normal state for hours or days.
- Impact: the token is a capability. `instructions.ts:96-102` states it exactly: whoever holds it can publish the `_navroop-verify` TXT record and pass `checkDomain` for that hostname. The guard that exists to withhold it is bypassed by the error string sitting next to it.
- Confidence: Confirmed
- Suggested fix: never put the expected token in a persisted, user-visible message — say the TXT record does not match and let the instructions carry the value, which is already access-controlled. Then have the redaction helper operate on a whitelist of fields rather than blanking known ones, so a new field cannot reopen this.

### F-209 [HIGH] "Deployment deleted" is reported when nothing was deleted

- Area: G
- Location: lib/publish/actions.ts:302-318, lib/publish/cleanup.ts:127-165, app/(app)/deployments/DeploymentsList.tsx:41-45
- What happens: `destroyDeployment` deliberately keeps the row when any provider delete failed and reports that through `failures` / `rowDeleted: false` (`cleanup.ts:154-165`, with a comment explaining that deleting the row would strand a billing container). `deleteDeploymentAction` ignores both fields and returns `{ ok: true, data: { id } }` unconditionally. The UI then settles a success toast and removes the row from the table (`DeploymentsList.tsx:41-45`).
- Trigger: click Delete while Coolify is unreachable, or when the App lacks `delete_repo`, or when the Cloudflare token has lost DNS edit.
- Impact: the user is told the deployment is gone, it disappears from the list, and the Coolify container keeps running and billing, the DNS record keeps resolving, and the deploy repo keeps existing. The row is still in the database, so the next page load contradicts the toast. All the machinery to report this honestly exists and is discarded one call up.
- Confidence: Confirmed
- Suggested fix: return `failures` and `rowDeleted` to the caller and render them — a partial teardown is a warning state, not a success, and the row must stay visible with a "could not fully remove" note and a retry. `purgeProjectPublishResources` already threads the same information for the cron path.

### F-210 [HIGH] The Connectors push force-replaces the whole tree in the user's own repository

- Area: H
- Location: lib/github/git-data.ts:100-173 (`pushViaGitDataApi`), lib/github/push.ts:142-166
- What happens: the tree is built from the generated files only, with no `base_tree` (`git-data.ts:117-125`), and `main` is moved with `force: true` (`:147-159`). The target is `Project.githubRepoFullName`, which is persisted on first push (`push.ts:150-153`) and reused forever after.
- Trigger: a user pushes, edits or adds anything in that repository themselves (a README, a workflow, a config file, their own commits), then pushes again from Navroop.
- Impact: every file they added is deleted and the history is force-moved past their commits, silently, with a success response. The repository is described to the user as theirs. There is no warning, no diff, and no way to opt into a merge.
- Confidence: Confirmed
- Suggested fix: pass `base_tree` so the commit is a delta over the current tip, and drop `force` in favour of a fast-forward that fails when the remote moved — then surface that failure as "this repository has changed since the last push". A separate branch plus PR is the safer default for a repo the product does not own.

### F-211 [HIGH] Retrying a never-successful publish can move it to a different Coolify server

- Area: G
- Location: lib/publish/execute.ts:284-286, :311-335 (`slug` step), :337-340, :369-395 (`app` step), lib/coolify/servers.ts:51-76 (`pickCoolifyServer`)
- What happens: the loop initialises `server` from `deployment.serverId` (`:284`), then the `slug` step — which runs whenever `hadSuccessfulDeployment` is false — unconditionally calls `deps.pickServer()` and overwrites both the local `server` and the row's `serverId` (`:327-334`). `auth` is computed _after_ that (`:340`). But `resourceIds` was seeded from the Deployment row (`publish.ts:147-151`), so a `coolifyAppUuid` created on the previous server survives, and the `app` step skips creation (`:370`). Likewise the `dns` step skips when `dnsRecordId` is already recorded (`:398`), leaving DNS pointing at the old IP.
- Trigger: a first publish fails after the `app` step (Coolify build error, network blip at `deploy`, timeout at `poll`), and the least-loaded server has changed by the time the user clicks Retry — which `pickCoolifyServer` recomputes from live deployment counts on every call.
- Impact: the retry talks to server B's API with server A's application uuid, so `addApplicationDomain` / `triggerDeploy` fail with a 404 the user cannot interpret, and the recorded `serverId` no longer matches where the app actually is — which also breaks `stopDeployment` and `destroyDeployment` (both resolve the server from `row.serverId`).
- Confidence: Confirmed (code path); Likely for how often the pick actually changes
- Suggested fix: pick the server exactly once, when the Deployment row is created, and never re-pick while any recorded resource exists on the old one. If a move is genuinely wanted, it is a migration that must delete-and-recreate the app and re-point DNS, not a side effect of the slug step.

### F-212 [MEDIUM] An undecryptable secrets blob reads as CONNECTED with no credentials

- Area: G
- Location: lib/integrations/secrets.ts:8-16, lib/integrations/store.ts:68, lib/integrations/messages.ts:11-16, lib/github/deploy-client.ts:67-77, lib/cloudflare/dns.ts:18-27
- What happens: `decryptSecretsBlob` returns `{}` on any failure — wrong `ENCRYPTION_KEY`, rotated key, corrupted ciphertext. `fromRow` puts that empty object on a row whose `status` is still `CONNECTED`, and `getMissingIntegrations` looks only at `status`. So the publish gate passes, and the failure surfaces much later: `requireAppCreds` throws "GitHub is not connected. Connect GitHub at /admin/integrations" (`deploy-client.ts:74`) at the `github` step, or `credentials()` throws "Cloudflare is not connected" as a 500 (`dns.ts:24`).
- Trigger: rotate or lose `ENCRYPTION_KEY`; restore a database dump into an instance with a different key.
- Impact: every publish fails mid-flight — after the slug has been claimed and, on the GitHub path, before anything is created — with a message that tells the user to connect an integration the admin can see is connected. `/admin/integrations` shows three green pills. The daily health cron (`lib/integrations/health.ts:121`) is the only thing that flips them to ERROR, so the contradiction can stand for up to 24 hours. This is the same class as the logged lesson "A saved-but-blank credential fails as the provider's 401, not as a config error".
- Confidence: Confirmed
- Suggested fix: distinguish "no secrets stored" from "stored secrets could not be decrypted" — return a typed failure from the decrypt helper, have `getIntegration` mark the row unusable, and make the publish gate refuse with "the stored credentials cannot be read on this instance (encryption key mismatch)". A boot-time probe over the integration rows would turn a 24-hour mystery into a startup error.

### F-213 [MEDIUM] `upsertIntegration` merges config but replaces secrets wholesale

- Area: G
- Location: lib/integrations/store.ts:124-133, app/api/integrations/sentry/start/route.ts:20-27, lib/integrations/cloudflare-connect.ts:113-121
- What happens: `nextConfig` is a spread merge over the existing config (`:130-133`), but `nextSecrets` is `encryptSecretsBlob(input.secrets)` — the entire blob is overwritten whenever any secret is supplied. Callers that legitimately write one secret therefore erase the others: `sentry/start` writes `{ clientSecret }` and drops the live `authToken`, `refreshToken` and `tokenExpiresAt`.
- Trigger: an admin re-opens the Sentry OAuth form and clicks Connect (for any reason, including a typo they then correct).
- Impact: the working Sentry credentials are destroyed and the row drops to PENDING; quota monitoring and heartbeat checks stop. The asymmetry is invisible at the call sites — every one of them looks like a partial update.
- Confidence: Confirmed
- Suggested fix: make the secrets write explicitly total or partial at the call site (`secrets` vs `mergeSecrets`), so erasing a credential is something a caller has to ask for. Mirroring the config behaviour by default is the least surprising choice.

### F-214 [MEDIUM] Re-running the Coolify or Cloudflare connect wizard blocks publishing immediately

- Area: G
- Location: app/api/integrations/coolify/route.ts:27-34, lib/integrations/cloudflare-connect.ts:112-121, lib/integrations/messages.ts:11-16
- What happens: the first half of each wizard writes `status: 'PENDING'` over the existing row before the operator has selected servers (Coolify) or a zone (Cloudflare). `missingIntegrationKinds` counts only `CONNECTED`.
- Trigger: an admin pastes the Coolify token to re-check the connection, or pastes a Cloudflare token on an account with more than one zone, and then navigates away or hits an error.
- Impact: Publish is blocked workspace-wide with "Coolify is not connected", and on the Cloudflare path `peekRootDomain` starts returning null — which also empties `expectedUrl` in `serializeDeployment` (`serialize.ts:35-37`) and arms F-207. Nothing warns the admin that starting the wizard takes publishing down.
- Confidence: Confirmed
- Suggested fix: keep in-progress wizard state out of the row that gates publishing — stage the candidate token/base URL separately and promote it to the live row only on completion. If a PENDING intermediate is unavoidable, keep the previous CONNECTED credentials serving until the new selection is saved, and warn in the UI.

### F-215 [MEDIUM] Coolify 5xx is retried on non-idempotent POST/PATCH/DELETE

- Area: G
- Location: lib/coolify/client.ts:162-164, :299-355 (`createApplication`), lib/publish/retry.ts:32-45
- What happens: `coolifyFetch` retries once on any `status >= 500` regardless of method, so a 502 from a proxy that arrived _after_ Coolify created the application re-POSTs `/api/v1/applications/public`. `createApplication` is additionally wrapped in `withProviderRetry` (`execute.ts:371`), which retries 5xx again — up to four create attempts. The `findApplicationByName` pre-check (`client.ts:300`) only helps if the first app is already visible in the list.
- Trigger: a gateway 5xx or a read timeout on the create call.
- Impact: duplicate Coolify applications for one deployment. Only one uuid is recorded, and `lib/publish/cleanup.ts:154-162` plus `lib/jobs/orphans.ts` delete strictly by recorded provenance — so the duplicate runs and bills forever with nothing in the product pointing at it. The same double-retry applies to the `domains` PATCH, where two interleaved read-modify-writes can drop a hostname.
- Confidence: Confirmed
- Suggested fix: retry only idempotent reads inside the transport; let mutating calls fail and be re-driven by the step machine, which already persists resource ids and skips completed steps. Where a create must be retried, give it a client-supplied idempotency key or re-read by name before the second attempt.

### F-216 [MEDIUM] A decrypt failure is treated as "this token was plaintext"

- Area: G
- Location: lib/coolify/servers.ts:11-17 (`decryptServerToken`), :35 and :45 (`publicServer`), lib/coolify/client.ts:110-120 (`tokenForServer`)
- What happens: both helpers catch the decrypt failure and return the stored string. `tokenForServer` additionally _guesses_ whether a value is encrypted by testing for `==` or `length > 80`. On failure the ciphertext is sent to Coolify as `Authorization: Bearer <ciphertext>`, and `publicServer` computes `last4FromSecret` over the same ciphertext, so `/admin/servers` displays the last four characters of the encrypted blob as if they were the token's.
- Trigger: `ENCRYPTION_KEY` rotated or a dump restored on an instance with a different key.
- Impact: every Coolify call fails with an authentication error that says nothing about encryption, and the admin screen actively confirms a token is present and looks plausible. The `catch` at `client.ts:116-118` explains itself as "stored plaintext during create before encrypt", a state the connect path no longer produces (`coolify-connect.ts:130` always encrypts).
- Confidence: Confirmed
- Suggested fix: store a version/marker with the ciphertext so encrypted and plaintext are distinguishable without guessing, and make a decrypt failure a typed error that the caller reports as a key mismatch. Never derive a displayed `last4` from a value that failed to decrypt.

### F-217 [MEDIUM] `applicationSslReady` substring-matches the whole serialised app, so SSL is "ready" almost always

- Area: G
- Location: lib/coolify/client.ts:491-504, lib/domains/verify.ts:39-47 and :148-167
- What happens: after confirming the hostname is listed, the check does `JSON.stringify(app).toLowerCase()` and returns true if that blob contains `ssl_certificate`, `letsencrypt` or `certificate_id` — matching **field names and unrelated settings**, not a certificate for this hostname. A Coolify application row that merely has a `certificate_id: null` field satisfies it.
- Trigger: any custom domain reaching the SSL step.
- Impact: the domain flips to `ACTIVE`, `sslIssuedAt` is stamped, the timeline says Live and 301s are applied while Let's Encrypt may not have issued anything — so the customer's hostname serves a certificate error and the product reports success. The genuine "still issuing" state (`verify.ts:148-154`) becomes unreachable.
- Confidence: Confirmed
- Suggested fix: verify the certificate for the specific hostname — either from a Coolify field that names it, or by an outbound TLS handshake against the hostname and an assertion on the presented SAN. Absent a trustworthy signal, keep the domain in `SSL_PENDING` and say so, rather than guessing from a stringified object.

### F-218 [MEDIUM] Deployment health falls back to the fqdn string when `status` is absent

- Area: G
- Location: lib/coolify/client.ts:382-398
- What happens: `const status = String(row.status ?? row.fqdn ?? '')`, and the health verdict is then substring matching over that value. If Coolify omits `status`, the application's hostname list is interpreted as a health string: a host containing `error`, `failed` or `dead` reads as `failed`, anything else reads as `building`.
- Trigger: a Coolify API shape change, a partial response, or an application row without `status`.
- Impact: either a spurious build failure or a ten-minute poll that ends in "Build did not become healthy within 10 minutes" for a site that is actually up. A hostname is not a health signal and should never have been a fallback for one.
- Confidence: Confirmed
- Suggested fix: treat a missing `status` as unknown and surface that explicitly — retry a bounded number of times, then fail with "Coolify did not report a status" instead of inventing one from an unrelated field.

### F-219 [MEDIUM] A DNS resolver failure is indistinguishable from "the records are missing"

- Area: G
- Location: lib/domains/dns.ts:4-26, lib/domains/verify.ts:70-117, :56-64, lib/domains/notify.ts:8-33
- What happens: all three resolvers swallow every error and return `[]`. `checkDomain` then reports `TXT … is missing; expected …` and keeps the domain in `PENDING_DNS`; after seven days `nextCheckDelayMs` returns `'failed'` and the domain is permanently marked `FAILED` and emailed to every admin.
- Trigger: SERVFAIL, a resolver timeout, or DNS being unavailable inside the container — including transiently, and including for the whole seven-day window if the container has no working resolver.
- Impact: the customer is told their DNS is wrong when it is correct, the recorded `lastError` sends them to fix records that already exist, and the terminal FAILED state is unreachable-from-the-product (the row leaves `listCheckableCustomDomains`). This is the logged "`[]` / `{}` / `false` is not 'nothing happened'" lesson, on a path that ends in a permanent state plus an email.
- Confidence: Confirmed
- Suggested fix: return a discriminated result — records / NXDOMAIN / lookup-failed — and treat lookup-failed as "could not check": do not advance the 7-day clock, do not overwrite `lastError` with a mismatch sentence, and count it as a cron error (`lib/domains/cron.ts:31-35` already distinguishes "ours" from "theirs" and would report it correctly).

### F-220 [MEDIUM] Apex and zone detection assume two labels, so `.co.in` / `.co.uk` are handled wrongly

- Area: G
- Location: lib/domains/hostname.ts:20-28, lib/domains/instructions.ts:14-23 and :48-52, lib/domains/create.ts:78-79, lib/cloudflare/zones.ts:48-76
- What happens: `isApexHostname` is `labels.length === 2` and `zoneNameForHostname` returns the last two labels. For `example.co.in`: it is not "apex", so the product asks for a **CNAME at the zone apex** (invalid DNS) and `checkDomain` verifies a CNAME that can never exist (`verify.ts:96-108`); and Path B computes the zone name as **`co.in`** and asks Cloudflare to create it (`create.ts:78-79` → `createOrGetClientZone`).
- Trigger: a customer adds any hostname under a multi-label public suffix — `.co.in` is the common case for this product's stated Indian context, plus `.co.uk`, `.com.au`, `.co.za`.
- Impact: Path A verification can never pass, so the domain sits pending for seven days and then fails. Path B attempts to register a public suffix as a customer zone — best case Cloudflare refuses with a message the user cannot act on, worst case a zone is created for the wrong name and (per policy) never deleted.
- Confidence: Confirmed
- Suggested fix: use a public-suffix list to derive the registrable domain and to decide apex vs subdomain; the label count is not a substitute. Until then, refuse Path B for hostnames whose registrable domain cannot be determined confidently rather than guessing.

### F-221 [MEDIUM] Path B creates the Cloudflare zone before the database row, and zones are never deleted

- Area: G
- Location: lib/domains/create.ts:76-112, lib/cloudflare/zones.ts:47-76, lib/publish/cleanup.ts:29-44
- What happens: for Path B the zone and its A/CNAME + TXT records are created first (`create.ts:79-95`), and only then is `insertCustomDomain` called (`:103`). If that insert throws — a `DuplicateHostnameError` from a concurrent add, or any database failure — the function returns an error and the zone stays on the Cloudflare account with **nothing in the product referencing it**. The teardown paths deliberately never delete a zone and rely on `cloudflareZoneId` being recorded on the row to report it (`cleanup.ts:29-44`).
- Trigger: two users add the same hostname concurrently; or a database error between the Cloudflare call and the insert.
- Impact: an orphaned zone that consumes the account's zone allowance, is invisible to `/admin`, and cannot be reported by the audit trail that was specifically built to preserve zone ids. Repeatable, so it accumulates.
- Confidence: Confirmed
- Suggested fix: reserve the row first (PENDING, unique on hostname), then provision Cloudflare, then fill in the zone id — so the database is always the record of what exists externally. If provisioning fails, the row is the receipt that lets an operator find or retry it.

### F-222 [MEDIUM] The domain row is deleted even when detaching the hostname from Coolify failed

- Area: G
- Location: lib/domains/actions.ts:152-160, lib/domains/cleanup.ts:27-44
- What happens: `removeProjectDomain` calls `removeDomainFromCoolify` inside a `try` whose `catch` only `console.warn`s, then unconditionally deletes the `CustomDomain` row. `removeDomainsForDeployment` does the same per row.
- Trigger: remove a custom domain while Coolify is unreachable or returns an error.
- Impact: the hostname stays attached to the Coolify application with no row naming it, so it keeps being served and keeps its certificate, and no later pass can find it (removal is driven from the rows). Reusing that hostname on another project then collides inside Coolify with no explanation.
- Confidence: Confirmed
- Suggested fix: keep the row when the detach fails, mark it as "removal pending" with the error, and retry from the domain cron — the same "the row is the surviving receipt" reasoning `lib/publish/cleanup.ts:154-162` already applies to deployments.

### F-223 [MEDIUM] `stopDeployment` detaches the domains and then throws, leaving the row not STOPPED

- Area: G
- Location: lib/publish/cleanup.ts:207-223 vs :46-72
- What happens: `stopDeployment` guards the domain detach but calls `stopApplication` **unguarded** (`:217`), so a Coolify error propagates out of the server action before `status: 'STOPPED'` is written. `stopProjectDeployments` — the same operation for a soft-deleted project — guards it (`:59-64`) and always writes STOPPED.
- Trigger: click Stop on `/deployments` while Coolify is unreachable.
- Impact: the custom domains have already been detached from the application, but the row still says LIVE, the site may still be running, and the UI shows an error. The two code paths for one concept disagree about whether a Coolify failure is fatal.
- Confidence: Confirmed
- Suggested fix: make the two paths share one implementation with one answer: try to stop, record whether it succeeded, and only claim STOPPED when it did — with the domain detach ordered after (or reversed on) a failed stop.

### F-224 [MEDIUM] The sandbox git push path puts the user's GitHub token in argv and `git add -A`s everything

- Area: H
- Location: lib/github/sandbox-git.ts:19-62, lib/github/push.ts:161-166
- What happens: this is documented as the "preferred push path" (`sandbox-git.ts:16`). It runs `git init`, `git add -A`, `git commit`, then `git push https://x-access-token:<token>@github.com/<repo>.git HEAD:main --force` **inside the generation sandbox** — the process that executes AI-generated code. The exit codes of `init`, `checkout`, `add` and `commit` are all discarded (`:44-55`); only `git --version` and the final push are checked. `git add -A` in the sandbox working directory stages `node_modules`, build output and any `.env` the model wrote, since no ignore file is guaranteed on disk. Currently unreachable: nothing in the repository assigns `globalThis.activeSandbox` (only `types/sandbox.ts:26` declares it and tests delete it), so `trySandboxGitPush` returns false at `:27` and the Git Data fallback runs.
- Trigger: any code that sets `global.activeSandbox` re-arms the whole path.
- Impact: if armed — the user's `repo`-scoped GitHub token appears in the argv of a process inside a sandbox running untrusted generated code, and the push carries `node_modules` and possibly secrets, force-overwriting `main`. A silent `catch { return false }` (`:60-62`) also means a partial local commit is left behind with no report.
- Confidence: Confirmed (code); Confirmed that the path is currently dead
- Suggested fix: delete it. The Git Data API path is the one that runs, it does not need a credential inside the sandbox, and it does not stage the sandbox's whole filesystem. If sandbox-side git is ever wanted, pass the credential through a git credential helper on stdin and stage an explicit file list.

### F-225 [MEDIUM] The push file source reads a process-global cache with no project scoping

- Area: H
- Location: lib/github/current-files.ts:13-25 and :57-60, lib/github/push.ts:133, lib/checkpoints/snapshot.ts:20
- What happens: `filesFromCache()` reads `globalThis.sandboxState.fileCache.files` and, if non-empty, returns it **in preference to** the project's own `lastCode` — with no project id anywhere in the lookup. Nothing writes that global today (`tests/unit/edit-context-from-project.test.ts:10-12` says so explicitly), so it always returns `{}`.
- Trigger: any code that repopulates `global.sandboxState.fileCache`.
- Impact: if repopulated, `pushProjectToGitHub(projectId)` and `captureFileSnapshot(projectId)` would both return whichever project last touched the cache — pushing another user's project code into this user's repository and into this project's checkpoints. `captureFileSnapshot` feeds publish, checkpoints and export, so the same landmine sits under all three.
- Confidence: Confirmed (the unscoped read); the leak is latent, not live
- Suggested fix: remove the global-cache branch — `getCurrentProjectFiles` already takes the project and should read only from it. A cache keyed by nothing cannot be made safe by its callers.

### F-226 [MEDIUM] The Sentry round-trip verification can never succeed

- Area: G (integrations)
- Location: lib/integrations/sentry-verify.ts:21-28 and :62-65, lib/observability/sentry-api.ts:78-80
- What happens: `sendDsnVerificationEvent` posts an event with tags but **no `fingerprint`**; the poll then searches Sentry for `fingerprint:navroop-sentry-verify` (`sentry-verify.ts:64` → `sentry-api.ts:79`). Compare the heartbeat, which does set `fingerprint: [HEARTBEAT_FINGERPRINT]` (`lib/observability/heartbeat.ts:36`) and is therefore findable.
- Trigger: admin clicks Verify on `/admin/integrations` with an auth token connected.
- Impact: the outcome is always `sent_not_received`, and the message the operator reads is "Event sent but not received. Likely causes: quota exhausted, rate limited, inbound filter, or wrong project" (`lib/integrations/sentry.ts:10-11`) — an accusation against a correctly configured integration, which sends the operator to investigate quotas that are fine. Sixty seconds of polling every time (`sentry.ts:96`).
- Confidence: Confirmed
- Suggested fix: send the verification event with the fingerprint the poll searches for, and pin the pair in one place so they cannot drift. A test that asserts the sent payload's fingerprint equals the polled query would have caught this.

### F-227 [MEDIUM] The Sentry OAuth callback is fully public and, unlike its GitHub twin, has no admin check

- Area: G (integrations)
- Location: app/api/integrations/sentry/callback/route.ts:11-51, lib/auth/public-routes.ts:160-164, app/api/integrations/github/callback/route.ts:9-18, lib/integrations/sentry-oauth.ts:34-49
- What happens: the route is on the public allowlist ("Sentry redirects the OAuth callback back to us", `public-routes.ts:163`) and performs no `requireAdmin()`. Its only guard is a single-use nonce stored in **one global `AppSetting` row** (`integration.sentry.oauth`), which any new flow overwrites. The GitHub App callback, which does the same job, is admin-gated and additionally checks `csrf.userId !== user.id` (`github/callback/route.ts:16`).
- Trigger: a request carrying a valid `state` from anywhere — no session at all.
- Impact: an unauthenticated caller holding the redirect URL (browser history, a proxy log, a `Referer`) can complete the exchange, writing the Sentry credentials and `connectedById` for the workspace. Concurrent admin flows also clobber each other's nonce, so the second one silently invalidates the first.
- Confidence: Confirmed
- Suggested fix: mirror the GitHub callback — require an admin session and bind the nonce to that session's user id, keeping the public allowlist entry only if the provider genuinely cannot carry a cookie. Store OAuth state per-flow (a row keyed by the state value) instead of one global row.

### F-228 [MEDIUM] Admin-supplied hosts are fetched without the SSRF guard

- Area: G (integrations)
- Location: lib/integrations/coolify-connect.ts:20-34 and :72-104, app/api/integrations/coolify/route.ts:14-25, lib/integrations/sentry-verify.ts:13 and :30-38
- What happens: `discoverCoolify`/`createCoolifyProject` `fetch` an **arbitrary base URL from the request body** with no validation beyond a trim (the route only checks it is non-empty); `sendDsnVerificationEvent` builds its URL from the host inside a pasted DSN. Both use raw `fetch`. `lib/security/url-guard.ts` + `safeFetch` exist for exactly this and are documented as required for user-supplied URLs; the "trusted host" exemption covers Coolify/Cloudflare/GitHub/Resend/E2B, not a host typed into a form.
- Trigger: an ADMIN posts `{ baseUrl: "http://169.254.169.254" }` to `/api/integrations/coolify`, or connects a DSN pointing at an internal host.
- Impact: server-side requests to internal addresses with the response status reflected back in the error message (`coolify-connect.ts:77`) — a working internal port scanner and a cloud-metadata probe. ADMIN-only, so this is privilege amplification rather than a public hole, but the guard is one import away and every other user-supplied URL in the product uses it.
- Confidence: Confirmed
- Suggested fix: validate the Coolify base URL with the same origin parser `saveDeploySettings` already uses (`lib/coolify/actions.ts:11-19`) and route both calls through `safeFetch` so private ranges are refused and rejects are counted like every other SSRF attempt.

### F-229 [MEDIUM] Raw Coolify response bodies are stringified into the user-visible deployment error

- Area: G
- Location: lib/coolify/errors.ts:24-28, lib/coolify/client.ts:166-171, lib/publish/execute.ts:478-483, lib/publish/serialize.ts:50
- What happens: when a Coolify error body has no `message`/`error`/`errors[0]`, `coolifyErrorMessage` falls back to `JSON.stringify(body)`. That becomes `CoolifyApiError.message`, which `runPublishJob` writes into `Job.errorMessage` and `Deployment.lastError`, which `serializeDeployment` returns to any viewer of the publish sheet and `/deployments`.
- Trigger: any Coolify 4xx/5xx whose body is a bare object or array — for example a validation error on the application PATCH, whose body can echo the submitted application payload.
- Impact: an unfiltered provider response body is persisted and shown to a non-admin project owner. The publish payload includes `PREVIEW_PASSWORD` on the env-var path (`client.ts:220-236`) and basic-auth credentials on the create path (`client.ts:332-336`), so an echoing error body is a credible route for those to reach a user-facing string and the audit trail.
- Confidence: Confirmed for the raw-body path; Needs check for whether a real Coolify body ever echoes credentials
- Suggested fix: never persist a stringified provider body. Keep the structured body on the error object for server logs (scrubbed), and give the user a short mapped sentence plus the request id. A deny list of credential-shaped keys before any body is serialised anywhere would make this class impossible.

### F-230 [MEDIUM] Preview injection overwrites the project's own middleware, and the noindex helper only writes a comment

- Area: G
- Location: lib/publish/preview-inject.ts:39, :43-48, :60-63
- What happens: `next['middleware.ts'] = previewMiddlewareSource(...)` replaces any `middleware.ts` the generated project has, unconditionally. And `ensureNextNoindexHeaders`, which the code reads as "make sure the config sets the header", appends only `// navroop-preview-noindex: add X-Robots-Tag via middleware.ts` — it adds no header at all, and its `source.includes('X-Robots-Tag')` guard then makes that comment count as "already handled" on the next pass.
- Trigger: publish a preview of a NEXTJS project that has its own `middleware.ts` (auth, redirects, i18n).
- Impact: the preview silently behaves differently from the project the user is looking at — their middleware is gone from the deployed build. A user debugging their own auth in preview has no way to see why. The misleading helper name invites the next reader to believe the config path is covered.
- Confidence: Confirmed
- Suggested fix: compose rather than replace — emit the preview gate as a separate module and wrap the project's existing middleware, or refuse to inject and report "this project already has middleware; the preview gate cannot be added" instead of deleting it. Rename the config helper to say what it does, or delete it.

### F-231 [MEDIUM] Preview password: non-constant-time compare, ignored username, and no rollback of the plaintext

- Area: G
- Location: lib/publish/preview-inject.ts:91-93, lib/publish/publish.ts:205-236
- What happens: the injected gate compares with `password !== expected` (a byte-by-byte comparison that returns early) and ignores the Basic-auth username entirely. On the node-stack path `updatePreviewPassword` writes the plaintext to the Coolify application as `PREVIEW_PASSWORD` (`publish.ts:210`) and _then_ re-publishes; when the publish fails it carefully rolls the `passwordHash` back (`:224-228`) but leaves the new plaintext on the Coolify app.
- Trigger: set or change a preview password on a node stack; then guess the password against the deployed preview.
- Impact: the comparison leaks length and prefix information to a remote attacker over repeated requests — weak, but this is the only thing protecting an unpublished site. And after a failed password change the stored hash says one thing while the container's env var says another, so a later successful publish deploys a gate that accepts the abandoned password.
- Confidence: Confirmed
- Suggested fix: compare with a constant-time equality over the decoded credentials (and decide explicitly whether the username matters). Order the writes so the env var is only updated once the build that consumes it has landed, and roll it back alongside the hash when it has not.

### F-232 [MEDIUM] Setting a preview password runs a full publish inline in a server action, with no lock and no gate

- Area: G
- Location: lib/publish/publish.ts:213-237, lib/publish/actions.ts:211-224, app/api/projects/[id]/publish/password/route.ts:4-14
- What happens: on the node-stack path `updatePreviewPassword` calls `startPublishJob` **and awaits `runPublishJob`** in the request. That loop polls Coolify for up to ten minutes (`lib/publish/constants.ts:7`). Unlike the real publish entry points it takes no project lock, does not check the integrations, does not check the plan slot, and the password route does not declare a `maxDuration` (the publish route sets 600, `publish/route.ts:18`).
- Trigger: set a preview password on a NEXTJS project.
- Impact: the action hangs for minutes and will usually be cut off by the platform's request timeout, after which `setPreviewPasswordAction` reports "Password update fail" with status 400 (`actions.ts:217-223`) for a publish that is still running. Because no lock is held, it can also interleave with a generation or another publish — the exact re-entrancy `security review NAV-03` (quoted at `lock.ts:199-205`) was about.
- Confidence: Confirmed
- Suggested fix: make it start the publish job and return, exactly as `startPublish` does — hold the project lock, run under `after()`, and let the UI follow the job's steps. The password write and the rollback then belong to the job, not to a request that will not survive.

### F-233 [MEDIUM] Provider inventories are capped at one page with no pagination

- Area: G / H
- Location: lib/cloudflare/dns.ts:108-123 (`per_page=100`), lib/github/deploy-client.ts:296-312 (`per_page=100`)
- What happens: `listZoneARecords` and `listDeployRepos` request a single page of 100 and return it as the complete inventory. Neither follows `Link` headers or `page=`. `listZoneARecords`' own doc-comment calls it "Every A record in the zone" (`dns.ts:102`).
- Trigger: a zone with more than 100 A records, or an org with more than 100 repos — reached after 100 publishes.
- Impact: the orphan reconciliation that consumes these lists silently sees a partial picture and reports "no orphans" while orphaned apps, records and repos accumulate and bill. This is the same "could not look ≠ nothing there" distinction `listManagedApplications` was fixed to honour (`lib/coolify/client.ts:266-277`); here the truncation is quieter still, because the call succeeds.
- Confidence: Confirmed
- Suggested fix: paginate both until exhausted, and have each function report whether it reached the end — a caller that deletes based on an inventory must refuse to act on a truncated one.

### F-234 [MEDIUM] Installation tokens are cached in plaintext on the volume and never invalidated on rejection

- Area: H
- Location: lib/github/deploy-client.ts:19-53, :137-156
- What happens: installation tokens are written to `/data/cache/github-tokens.json` **unencrypted** (`persistToken`, `:37-53`) with a 50-minute TTL, keyed only by workspace id. Nothing clears the cache when GitHub rejects the token: `githubJson` returns 401/403 and every caller throws a `GithubAppError`, but `readPersistedToken` keeps serving the same value until it expires. The file is documented as reconstructible (`:5-8`), which is true, but everything else in this system keeps credentials in Postgres under AES-256-GCM.
- Trigger: uninstall the GitHub App, rotate its private key, or have GitHub revoke a token mid-window; then publish.
- Impact: up to 50 minutes of publishes failing with GitHub's own message after the operator has already fixed the installation, with no way to force a refresh from the product. And a short-lived org-write credential sits in cleartext on a mounted volume that is explicitly outside the encrypted store and outside backups.
- Confidence: Confirmed
- Suggested fix: drop the cache entry when a call using it is rejected, and re-mint once before failing. Encrypt the file with the same key as the rest of the credential material, or keep the cache in-process only — the rate-limit argument for persisting it does not require plaintext.

### F-235 [MEDIUM] Installation discovery falls back to whichever installation GitHub lists first

- Area: H
- Location: lib/integrations/github.ts:72-93
- What happens: the match is `requested id`, else `account login equal to the configured org`, else **`list[0]`**. On that last branch the code then _overwrites_ `org` and `accountLogin` with whatever it found and marks the integration CONNECTED.
- Trigger: the App is installed on more than one account (a personal account and the org, or two orgs), and the configured org's login does not match — for example after the org was renamed.
- Impact: publishing silently binds to the wrong GitHub account and starts creating, force-pushing to and deleting repositories there, with the product's own record of `org` rewritten to match so nothing looks wrong. Combined with F-202 this points the destructive write path at an unintended account.
- Confidence: Confirmed
- Suggested fix: require an explicit match. When the requested/configured account is not among the installations, leave the row PENDING and ask the admin which installation to use — never adopt an arbitrary one and never rewrite the configured org from a guess.

### F-236 [MEDIUM] Sentry scope validation is skipped when the token response omits `scope`

- Area: G (integrations)
- Location: lib/integrations/sentry-oauth.ts:160-167
- What happens: `if (!scopes.includes(required) && scopes.length > 0)` — when `scopes` is empty (no `scope` field, or an unparsable one) every required scope check is skipped and the token is accepted as fully scoped.
- Trigger: Sentry returns a token response without `scope`.
- Impact: the integration is stored CONNECTED and not `limited`, then every quota/heartbeat/issue call fails later with a 403 that reads as a Sentry outage rather than a missing scope. The guard exists precisely to catch this at connect time.
- Confidence: Confirmed
- Suggested fix: treat an absent scope list as unverified — either probe the token (`inspectSentryToken` already does exactly this) or store the connection as `limited` with a message saying the scopes could not be confirmed.

### F-237 [MEDIUM] A Sentry token with no recorded expiry is never refreshed

- Area: G (integrations)
- Location: lib/integrations/sentry-oauth.ts:213-224
- What happens: `expiringSoon` requires a parseable `tokenExpiresAt`; when it is absent the comparison is `NaN` and the guard is false, so the existing token is returned unconditionally (`:217`). And if refresh material is missing, the stale token is still returned as `ok` (`:222`).
- Trigger: Sentry's token response omits `expires_in` (`exchangeSentryCode:172-174` then stores no expiry), or the secrets blob loses `clientSecret`.
- Impact: the token is used until Sentry rejects it, at which point quota monitoring and health checks fail with a 401 rather than refreshing. "We don't know when this expires" is silently converted into "it does not expire".
- Confidence: Confirmed
- Suggested fix: treat an unknown expiry as expiring now and attempt a refresh, or record a conservative expiry at exchange time. Returning a token the code cannot vouch for should at least be reported as `limited`.

### F-238 [MEDIUM] The Cloudflare permission probe can leave a TXT record in the customer's zone, silently

- Area: G
- Location: lib/integrations/cloudflare-connect.ts:61-85
- What happens: the probe creates `_navroop-check.<zone>` TXT, then deletes it with `.catch(() => undefined)` — and only if the create response contained an `id` (`:80-83`). A failed delete, or a create whose response shape differs, leaves the record behind with nothing logged.
- Trigger: connect a Cloudflare token; the delete fails or the response omits the id.
- Impact: a stray record in the operator's production DNS zone that nothing in the product knows about or will clean up, and no log line to explain where it came from. The bare `.catch` also hides a genuine permission problem (create allowed, delete denied) that the probe is supposed to be measuring.
- Confidence: Confirmed
- Suggested fix: log the failed cleanup and report it to the operator as part of the connect result, and treat a create whose id is unreadable as a probe failure. Better still, probe with a read-only or dry-run call so nothing has to be cleaned up.

### F-239 [MEDIUM] Publishing LIVE while a PREVIEW publish runs returns the preview job and publishes nothing

- Area: G
- Location: lib/publish/publish.ts:75-84, lib/publish/actions.ts:161-172
- What happens: the active-job short-circuit checks only `active.kind === 'PUBLISH'`; it does not compare `active.inputPrompt` (which carries PREVIEW/LIVE) with the requested `kind`. It returns `{ jobId: active.id, deploymentId: existing?.id || active.id }` — and where the requested kind has no deployment row yet, the fallback hands back a **job id where a deployment id is expected**.
- Trigger: click Publish (Live) while a preview publish is still running.
- Impact: `startPublish` then calls `runPublishJob` on the preview job (adding a second runner to it, per F-203), the live publish never starts, and the UI's publish state points at the preview job's steps — so the user watches a progress bar to completion and gets no live site. The `active.id`-as-deployment-id fallback is a type-correct wrong answer that any caller trusting it will misuse.
- Confidence: Confirmed
- Suggested fix: compare the requested kind with the active job's kind and refuse with a clear "a preview publish is still running" message. Return `deploymentId: null` rather than an unrelated id when there is no row.

### F-240 [MEDIUM] The workspace name for the GitHub App and the Sentry project is a build-time env var with no admin setting

- Area: G (environment classification)
- Location: app/api/integrations/github/start/route.ts:17, lib/integrations/sentry-oauth.ts:324, lib/integrations/github-manifest.ts:3-10
- What happens: both read `process.env.NEXT_PUBLIC_WORKSPACE_NAME`. A `NEXT_PUBLIC_*` variable is **inlined at build time**, so changing the workspace name needs a rebuild and redeploy, not a restart — yet it is consumed server-side to name a GitHub App (`Navroop Deploy — <name>`, truncated to 34 chars) and to create a Sentry project. `github-manifest.ts:3-10` documents that the app _URL_ was moved out of the environment into `appPublicUrl()` for exactly this reason; the name was left behind.
- Trigger: an operator renames the workspace and re-runs either connect flow.
- Impact: the created GitHub App and Sentry project carry a stale name that cannot be corrected without a rebuild, contradicting the project rule that operator-changeable values belong in admin settings with env as fallback. Also mildly confusing: a `NEXT_PUBLIC_` name suggests a client value, and this one is only ever read on the server.
- Confidence: Confirmed
- Suggested fix: resolve it through the settings registry (`DB row → env → fallback`) like every other tunable, and label it runtime in `.env.example`. If it must stay an env var, drop the `NEXT_PUBLIC_` prefix so its build-time nature is not accidental.

### F-241 [MEDIUM] `/deployments` type-imports from a Prisma-importing module and formats dates with bare `toLocaleString`

- Area: G
- Location: app/(app)/deployments/DeploymentsList.tsx:1, :8, :120; lib/publish/serialize.ts:2; lib/publish/slug.ts:1-3
- What happens: `DeploymentsList` is `'use client'` and does `import type { PublicDeployment } from '@/lib/publish/serialize'`. `serialize.ts` value-imports `./slug`, and `slug.ts` imports `@/lib/db` (Prisma) and `@/lib/logger`. It is type-only today, so the import is elided and nothing reaches the browser graph — but `AGENTS.md` lists this exact pattern under "Do not" ("Do not `import type` a payload from a file that imports Prisma"), because dropping the `type` keyword turns the page into a cold-compile 500, and the boundary guard test only walks value imports. Separately, `:120` renders `new Date(row.publishedAt).toLocaleString()` in a client component whose first paint is server-rendered.
- Trigger: any edit that converts the type import to a value import; and, for the date, any client whose locale differs from the server's.
- Impact: a latent Turbopack panic on `/deployments` that would present as an intermittent 500 (200 on retry), which the logged lesson warns is not proof of a fix; plus a hydration mismatch on the timestamp column.
- Confidence: Confirmed (both patterns); the 500 is latent
- Suggested fix: move `PublicDeployment` into a client-safe types module with no Prisma reachable from it, and format the timestamp with the shared pinned formatter the admin pages use.

### F-242 [MEDIUM] OAuth/CSRF state lives in one global row per provider, so concurrent admins clobber each other

- Area: G (integrations)
- Location: lib/integrations/csrf.ts:5 and :23-27, lib/integrations/sentry-oauth.ts:11 and :43-47
- What happens: both flows `upsert` a single `AppSetting` row (`integration.github.csrf`, `integration.sentry.oauth`). Starting a flow overwrites any in-flight one.
- Trigger: two admins connect at once, or one admin opens the connect flow twice (a common reflex after a slow redirect).
- Impact: the first admin's callback fails state validation and redirects to a generic `?reason=state` error with nothing explaining why. `consumeRow` correctly refuses to proceed on a lost race (`single-use.ts:16-32`), so the failure is safe — but it is unexplained and repeatable.
- Confidence: Confirmed
- Suggested fix: key the state row by the state value itself (one row per flow, TTL-pruned), so concurrent flows are independent and a failed validation can say whether the nonce was unknown, expired or already used.

### F-243 [MEDIUM] The integration cache is invalidated only in the process that wrote it

- Area: G
- Location: lib/integrations/store.ts:19-43, :155, :191, :211
- What happens: `getIntegration` caches the decrypted row for 30 s in a module-level `Map`. `invalidateIntegrationCache` clears only that process's map.
- Trigger: more than one app instance (the deployment target is Coolify, and the compose file plus a restart-during-deploy both produce overlapping processes).
- Impact: for up to 30 s after a disconnect or a credential change, another instance keeps using the previous credentials — including publishing with a token the operator has just revoked, and reading a `zoneName` that is no longer connected. Small window, but the value cached is credential material and the invalidation is advertised as authoritative.
- Confidence: Confirmed
- Suggested fix: either drop the cache for secret-bearing reads or make invalidation cross-process (a version column bumped on write and checked cheaply, or a short cache keyed on that version).

### F-244 [MEDIUM] Before a slug is claimed the product shows a URL that may belong to a different site

- Area: G
- Location: lib/publish/actions.ts:88-103, lib/publish/serialize.ts:35-37, lib/publish/slug.ts:21-31
- What happens: while the slug is still `pending-…`, both the publish sheet's `previewUrl`/`liveUrl` and `serializeDeployment`'s `expectedUrl` substitute the literal string `site`, producing `https://site.<zone>` / `https://preview-site.<zone>`. Meanwhile `slugFromName` genuinely returns `site` for any name that slugifies to nothing (`slug.ts:30`), so `site` can be a real, claimed slug belonging to another project.
- Trigger: open the Publish sheet before the first publish completes.
- Impact: the user is shown a confident URL that is not theirs and, in the collision case, resolves to somebody else's published site. "We don't know the address yet" is being rendered as a specific wrong address.
- Confidence: Confirmed
- Suggested fix: show the resolved slug or nothing — compute the candidate slug for display (`resolveUniqueSlug` is already called two lines above) rather than substituting a placeholder that is also a valid slug, and reserve `site` so the placeholder can never collide.

### F-245 [LOW] Teardown and domain failures go to `console.warn` instead of the structured logger

- Area: G
- Location: lib/publish/cleanup.ts:54, :62, :121, :133, :141, :149, :213; lib/domains/cleanup.ts:36, :41; lib/domains/actions.ts:124, :155, :158; lib/domains/cron.ts:34; lib/checkpoints/actions.ts:145 (adjacent)
- What happens: the same file uses `log.warn` for some failures (`cleanup.ts:113`, `:124`, `:160`) and `console.warn` for others, including every provider-delete failure.
- Impact: those lines carry no request id, are not scrubbed by the Sentry scrubber, and are invisible to the structured log search an operator uses during an incident — precisely for the failures that leave billing resources behind.
- Confidence: Confirmed
- Suggested fix: use `log.warn` with the deployment/domain id everywhere in these paths; keep `console` out of server code so the scrubber cannot be bypassed.

### F-246 [LOW] Path B instructions duplicate a single nameserver row

- Area: G
- Location: lib/domains/instructions.ts:31-45
- What happens: the two-row `map` is followed by `.concat(nameservers.length === 1 ? [ …same value… ] : [])`, so a zone that reported one nameserver produces the same NS row twice. The `map` also takes an unused `index` parameter.
- Impact: the customer is told to add the same nameserver twice; the placeholder path shows "Pending nameservers" twice.
- Confidence: Confirmed
- Suggested fix: emit one row per distinct nameserver and say plainly when fewer than two are known yet.

### F-247 [LOW] An incoherent condition in `normalizeHostname`

- Area: G
- Location: lib/domains/hostname.ts:14
- What happens: `if (value.startsWith('www.') === false && value.includes(' ')) return null;` — a hostname containing a space is rejected unless it starts with `www.`, in which case it falls through to `HOST_RE`, which rejects spaces anyway. The condition can never change the outcome.
- Impact: none at runtime; it is a reader trap that implies `www.` hostnames are special here.
- Confidence: Confirmed
- Suggested fix: delete it and let the single regex decide.

### F-248 [LOW] Any Cloudflare 403 is reported as "DNS Edit permission missing"

- Area: G
- Location: lib/integrations/cloudflare.ts:22-29
- What happens: the second branch fires on `body?.status === 403` regardless of the error text, and its `joined.includes('edit') || joined.includes('permission')` terms match many unrelated messages. Operator precedence on line 19 (`a || (b && c)`) is also relying on the reader knowing `&&` binds tighter.
- Impact: an IP-restricted token, a suspended account or a rate limit all tell the admin to add a DNS Edit permission they already have.
- Confidence: Confirmed
- Suggested fix: map only recognised Cloudflare error codes to advice and pass anything else through with the provider's own message; parenthesise the condition.

### F-249 [LOW] A matching A record is accepted without checking that it is still proxied

- Area: G
- Location: lib/cloudflare/dns.ts:86-87
- What happens: `if (existing.content === ip) return existing.id` — the `proxied: true` and `ttl: 1` fields in the payload are never asserted against the existing record.
- Impact: if the record was switched to grey-cloud (by hand, or by another tool), publish reports the DNS step succeeded and the site is served without the proxy — no WAF, origin IP exposed, and the certificate story changes.
- Confidence: Confirmed
- Suggested fix: compare the fields that matter and PUT when any of them differ, not only on a content mismatch.

### F-250 [LOW] `getInstallationId` swallows the database error

- Area: H
- Location: lib/github/deploy-client.ts:125-133
- What happens: the workspace lookup for `githubOrgInstallationId` is wrapped in `try { … } catch { return creds.installationId }` with nothing logged.
- Impact: a database problem quietly changes which GitHub installation the publish authenticates as. It happens to fall back to the configured value, so the effect is usually benign — but it is unlogged and it is a credential-selection decision.
- Confidence: Confirmed
- Suggested fix: log the failure with the workspace id before falling back, so the fallback is observable.

### F-251 [LOW] A failed ref read is treated as "the branch does not exist"

- Area: H
- Location: lib/github/deploy-client.ts:213-214 and :243-259, lib/github/git-data.ts:98 and :147-173
- What happens: `parentSha = ref.ok ? … : undefined`. A 403, 500 or an unexpected body shape produces `undefined`, which routes the code into the "create the ref" branch.
- Impact: the create then fails with GitHub's "Reference already exists" (422), which reads like a product bug rather than "we could not read the branch". In the worst case a commit with no parent is created and discarded.
- Confidence: Confirmed
- Suggested fix: branch on the status — 404 means absent, anything else means unknown and must fail with that distinction, per the "could not look ≠ nothing there" rule already applied elsewhere.

### F-252 [LOW] Coolify legacy settings: a dead `'env'` source and a token that a base-URL-only save can erase

- Area: G
- Location: lib/coolify/settings.ts:70-88, :48-58
- What happens: `getCoolifyCredentials` declares `source: 'env' | 'stored' | 'none'` but can never return `'env'` (no env token is read — `client.ts:13` says so). And `saveStoredCoolifySettings` computes `nextToken = input.token || existing.token`; when `existing.token` is null because the stored ciphertext failed to decrypt (`:34-40`), saving only a new base URL writes `tokenEncrypted: null` and destroys the row's token.
- Impact: dead branches in the admin surface (`lib/coolify/actions.ts:31`), and one save can silently clear a credential the operator did not touch.
- Confidence: Confirmed
- Suggested fix: drop `'env'` from the union, and refuse to write a null token when the previous value merely could not be decrypted — that is a key problem, not an instruction to delete.

### F-253 [LOW] Three publish steps share one label, and `repoBranch` is honoured by Coolify but ignored by the push

- Area: G
- Location: lib/publish/steps.ts:2-11, lib/publish/execute.ts:374, lib/github/deploy-client.ts:213 and :244-254
- What happens: `PUBLISH_STEPS` gives `files`, `slug` (both "Preparing files") and `dns`/`domain` ("Connecting the domain") and `deploy`/`poll` ("Build in progress") duplicate labels — deliberate, since `PUBLISH_STEPPER` collapses them, but `stepLabel` is also used directly. Separately, `createApplication` is told to build `deployment.repoBranch || 'main'` while `pushFiles` hardcodes `refs/heads/main`.
- Impact: a failure at `slug` is reported to the user as "Preparing files", which is the previous step's name. And should `repoBranch` ever hold anything but its default, Coolify would deploy a branch the push never writes — the column exists and is settable in the schema (`prisma/schema.prisma:606`) with nothing enforcing the coupling.
- Confidence: Confirmed
- Suggested fix: give each step a distinct label (or route all UI through the stepper) and derive the pushed ref from the same field Coolify is given, so the two cannot disagree.

---

## GAP — missing capabilities

### F-260 [GAP] A failed deployment gives the user no reason and no build log

- Area: G
- Location: app/(app)/deployments/DeploymentsList.tsx:101 and :10-15, lib/publish/serialize.ts:14-16
- `lastError`, `buildLogUrl` and `progressStep` are all serialised and none is rendered. The table shows "Failed" and three buttons. The Coolify application link is computed during publish (`execute.ts:427`) and stored, so the information exists — nothing surfaces it. Recovery is "click Redeploy and hope".

### F-261 [GAP] No size, count or binary guard before the single git tree POST

- Area: H
- Location: lib/github/deploy-client.ts:201-229
- Every file's content is inlined into one `POST /git/trees` body with no ceiling on file count, per-file size or total bytes, and `content` is sent as text — a base64 image in the snapshot would be committed as base64 text. A large project fails with GitHub's raw error at the `github` step, after the slug has been claimed. The ZIP export path has an explicit 10 MB per-file rule; publish has none.

### F-262 [GAP] Project assets are not published with the site

- Area: G
- Location: lib/publish/files.ts:27-51 (no asset source), lib/publish/execute.ts:293-301
- Uploaded, generated and stock images live in `ProjectAsset` + object storage, not in the checkpoint snapshot, so they are never pushed to the deploy repo. A published site therefore either references Navroop's origin for its images or renders broken ones. Nothing in the publish path reads assets or rewrites their URLs.
- Confidence: Confirmed for the absence in the publish path; Needs check for how asset URLs are emitted into generated markup.

### F-263 [GAP] The project owner is never told their custom domain failed

- Area: G
- Location: lib/domains/notify.ts:21-32
- `notifyDomainFailed` emails every ADMIN and nobody else. The person who added the hostname — and the only person who can fix the DNS — is not notified, seven days after they added it.

### F-264 [GAP] There is no rollback to a previous deployment

- Area: G
- Location: lib/publish/actions.ts:275-287 (`redeployAction` → `startPublish`), lib/publish/execute.ts:304-310
- Every publish, including Redeploy, ships the _current_ checkpoint. `Deployment.commitSha` is recorded but never used to redeploy an earlier commit, and the deploy repo's history is force-moved on every publish (F-202/F-210), so previous versions are not reachable there either. When a publish ships a broken site the only path back is restoring a checkpoint and publishing again.

### F-265 [GAP] The GitHub App webhook secret is stored but nothing ever verifies a webhook

- Area: H
- Location: app/api/integrations/github/callback/route.ts:36, lib/integrations/types.ts:27
- `webhook_secret` is persisted into the encrypted secrets blob and never read anywhere in the repository (no webhook route, no signature verification). It is a stored secret with no purpose, and its presence suggests a delivery path that does not exist — so nothing reacts to a repo being deleted, an installation being suspended, or a push arriving from elsewhere.

---

## IMPROVEMENT

### F-270 [IMPROVEMENT] The deploy App's permissions are org-wide with no repository allowlist

- Area: H
- Location: lib/integrations/github-manifest.ts:24-28
- `contents: write` plus `administration: write` across the installation is what makes F-202 (force-push over an unrelated repo) and `deleteDeployRepo` dangerous. Requesting the App be installed on selected repositories, or keeping deploy repos in a dedicated org, would bound the damage that any bug on this path can do.

### F-271 [IMPROVEMENT] The Connectors OAuth flow asks for the full `repo` scope

- Area: H
- Location: app/api/github/connect/route.ts:36, app/api/github/callback/route.ts:91
- `repo` grants read/write to every private repository the user can reach, to push one generated project. The stored `scope` is also recorded as `tokenJson.scope || 'repo'` — a claim, not a verified grant — and is never checked before a push. A user-to-server token from the connectors App (which the manifest already defines, `github-manifest.ts:39-63`) would be least-privilege.

### F-272 [IMPROVEMENT] Coolify API calls impersonate a Chrome browser

- Area: G
- Location: lib/coolify/client.ts:26-27, :148-149
- Both request paths send a full desktop Chrome `User-Agent`. Server-to-server calls should identify the product and version; a spoofed browser UA defeats the operator's ability to attribute traffic in Coolify's own logs and looks like an attempt to bypass something.

### F-273 [IMPROVEMENT] `getCoolifyClient().request` has no timeout

- Area: G
- Location: lib/coolify/client.ts:18-31 vs :152
- `coolifyFetch` uses `AbortSignal.timeout(30_000)`; the client returned by `getCoolifyClient` does not. Its callers include `testCoolifyApiConnection` (an admin action) and `restartNavroopApplication`, so an unresponsive Coolify hangs those requests until the platform kills them.

---

## Files reviewed

All 94 files in `audit/_scope-p3.txt` were read in full.

```
app/(app)/connectors/page.tsx — clean
app/(app)/deployments/DeploymentsList.tsx — F-209, F-241, F-260
app/(app)/deployments/page.tsx — clean
app/api/github/callback/route.ts — F-271
app/api/github/connect/route.ts — F-271
app/api/github/disconnect/route.ts — clean
app/api/github/push/route.ts — clean
app/api/github/status/route.ts — clean
app/api/integrations/cloudflare/route.ts — clean
app/api/integrations/cloudflare/zone/route.ts — clean
app/api/integrations/coolify/route.ts — F-214, F-228
app/api/integrations/coolify/select/route.ts — clean
app/api/integrations/github/callback/route.ts — F-265
app/api/integrations/github/installed/route.ts — clean
app/api/integrations/github/start/route.ts — F-240
app/api/integrations/sentry/callback/route.ts — F-227
app/api/integrations/sentry/connect/route.ts — clean
app/api/integrations/sentry/select/route.ts — clean
app/api/integrations/sentry/settings/route.ts — clean
app/api/integrations/sentry/start/route.ts — F-213
app/api/integrations/sentry/verify/route.ts — clean
app/api/projects/[id]/domains/[domainId]/route.ts — clean
app/api/projects/[id]/domains/route.ts — clean
app/api/projects/[id]/publish/password/route.ts — F-232
app/api/projects/[id]/publish/route.ts — F-203
lib/cloudflare/dns.ts — F-212, F-233, F-249
lib/cloudflare/zones.ts — F-220, F-221
lib/coolify/actions.ts — F-252
lib/coolify/client.ts — F-204, F-207, F-215, F-216, F-217, F-218, F-272, F-273
lib/coolify/constants.ts — clean
lib/coolify/errors.ts — F-229
lib/coolify/server-actions.ts — clean
lib/coolify/servers.ts — F-211, F-216
lib/coolify/settings.ts — F-252
lib/domains/actions.ts — F-207, F-222, F-245
lib/domains/backoff.ts — clean
lib/domains/cleanup.ts — F-222, F-245
lib/domains/create.ts — F-220, F-221
lib/domains/cron.ts — F-219, F-245
lib/domains/dns.ts — F-219
lib/domains/errors.ts — F-208
lib/domains/hostname.ts — F-220, F-247
lib/domains/index.ts — clean
lib/domains/instructions.ts — F-208, F-220, F-246
lib/domains/list.ts — F-208
lib/domains/notify.ts — F-263
lib/domains/redirects.ts — F-207
lib/domains/store.ts — clean
lib/domains/types.ts — clean
lib/domains/verify.ts — F-208, F-217, F-219
lib/github/actions.ts — clean
lib/github/connection.ts — clean
lib/github/current-files.ts — F-225
lib/github/deploy-client.ts — F-201, F-202, F-233, F-234, F-250, F-251, F-261
lib/github/git-data.ts — F-210, F-251
lib/github/oauth-config.ts — clean (localhost callback fallback noted under F-271's area; no separate finding)
lib/github/oauth-state.ts — clean
lib/github/push.ts — F-206, F-210, F-224, F-225
lib/github/repo-name.ts — clean
lib/github/sandbox-git.ts — F-224
lib/integrations/cloudflare-connect.ts — F-207, F-214, F-238
lib/integrations/cloudflare.ts — F-248
lib/integrations/coolify-connect.ts — F-228
lib/integrations/csrf.ts — F-242
lib/integrations/github-manifest.ts — F-240, F-270
lib/integrations/github.ts — F-235
lib/integrations/health.ts — F-212
lib/integrations/index.ts — clean
lib/integrations/messages.ts — F-206, F-212, F-214
lib/integrations/public.ts — clean
lib/integrations/secrets.ts — F-212
lib/integrations/sentry-credentials.ts — clean
lib/integrations/sentry-health.ts — clean
lib/integrations/sentry-oauth.ts — F-236, F-237, F-240, F-242
lib/integrations/sentry-persist.ts — clean
lib/integrations/sentry-restart.ts — F-273
lib/integrations/sentry-verify.ts — F-226, F-228
lib/integrations/sentry.ts — F-226
lib/integrations/single-use.ts — clean
lib/integrations/store.ts — F-212, F-213, F-243
lib/integrations/types.ts — F-265
lib/publish/actions.ts — F-203, F-209, F-232, F-244
lib/publish/cleanup.ts — F-209, F-223, F-245
lib/publish/constants.ts — clean
lib/publish/execute.ts — F-200, F-201, F-203, F-204, F-205, F-211, F-215, F-229, F-253
lib/publish/files.ts — F-200, F-201, F-262
lib/publish/limits.ts — clean
lib/publish/naming.ts — F-202
lib/publish/preview-inject.ts — F-230, F-231
lib/publish/publish.ts — F-203, F-205, F-213, F-231, F-232, F-239
lib/publish/retry.ts — F-215
lib/publish/serialize.ts — F-229, F-241, F-244
lib/publish/slug.ts — F-241, F-244
lib/publish/steps.ts — F-253
```

Related files read for context and cited, but **not** in this phase's scope:
`lib/deploy/repo-files.ts`, `lib/stacks.ts`, `lib/checkpoints/actions.ts`,
`lib/checkpoints/snapshot.ts`, `lib/jobs/lifecycle.ts`, `lib/jobs/compensate.ts`,
`lib/jobs/compensate-publish.ts`, `lib/projects/lock.ts`,
`app/api/projects/[id]/export/route.ts`, `lib/auth/public-routes.ts`,
`lib/observability/sentry-api.ts`, `lib/observability/heartbeat.ts`.

Nothing in scope was unreadable.
