import { prisma } from '@/lib/db';
import { filesFromReply } from '@/lib/generation/parse-blocks';
import {
  MAX_TOTAL_BYTES,
  ParseFilesError,
  type ParseFilesErrorCode,
} from '@/lib/generation/parse-files';
import { assertWritableGenerationFile } from '@/lib/generation/write-guard';
import {
  placeholderReplacements,
  replaceNeedImageTokens,
  sweepNeedImageTokens,
} from '@/lib/assets/need-image';
import { getCurrentProjectFiles } from '@/lib/github/current-files';
import { log, logError } from '@/lib/logger';
import { toLastCode } from '@/lib/projects/last-code';
import { failJob, succeedJob } from './lifecycle';
import { getJob } from './store';

/** A file the persist path refused, with the guard's own message. */
export type RejectedGeneratedFile = {
  path: string;
  code: ParseFilesErrorCode;
  message: string;
};

/** Rejections about the name, not the content — the copy for "all refused" differs. */
const PATH_REJECTION_CODES: Partial<Record<ParseFilesErrorCode, true>> = {
  empty: true,
  absolute_path: true,
  path_traversal: true,
  invalid_path: true,
};

/**
 * `filesFromReply` documents that it does not validate anything, and this is where
 * its entries become project file keys — read by the Code tab, the ZIP export and the
 * GitHub push, which turns a path into a tree entry. A fence path of
 * `../../secret.env`, `..\..\x` or `C:/x` must not survive; nor must a binary
 * payload, a file over the per-file cap, a batch over the total cap, or a
 * package.json that JSON.parse cannot read — those guards existed with no
 * production caller while a single 2 MB file sat in `Project.lastCode` and a
 * broken package.json shipped to the deploy repo (F-028). The per-file checks
 * are {@link assertWritableGenerationFile}; the cross-file total cap lives here.
 *
 * Dropped one at a time, not fatal: the generate route drops unsafe paths from its
 * own list the same way, so dropping here is what keeps the `complete` frame's file
 * count and what is actually stored in agreement, and one oversized file must not
 * cost the user the rest of a finished build. The caller does treat "all of them
 * rejected" as fatal, because that leaves nothing to store — see
 * {@link STREAM_REJECTED_PATHS_MESSAGE} and {@link STREAM_REJECTED_FILES_MESSAGE}.
 *
 * Exported so the rejection can be asserted without a database.
 */
export function safeGeneratedFiles(files: Record<string, string>) {
  const safe: Record<string, string> = {};
  const rejected: RejectedGeneratedFile[] = [];
  let totalBytes = 0;
  for (const [path, content] of Object.entries(files)) {
    let checked: { path: string; content: string };
    try {
      checked = assertWritableGenerationFile({ path, content });
    } catch (error) {
      if (error instanceof ParseFilesError) {
        rejected.push({ path, code: error.code, message: error.message });
        continue;
      }
      throw error;
    }
    const bytes = Buffer.byteLength(checked.content, 'utf8');
    if (totalBytes + bytes > MAX_TOTAL_BYTES) {
      rejected.push({
        path: checked.path,
        code: 'too_large',
        message: 'Generated output is too large',
      });
      continue;
    }
    totalBytes += bytes;
    safe[checked.path] = checked.content;
  }
  return { safe, rejected };
}

export const STREAM_NO_FILES_MESSAGE =
  'The AI finished without producing any files we could save. Try again.';

/**
 * Same outcome as {@link STREAM_NO_FILES_MESSAGE} from where the user stands — nothing was
 * saved — but it says why, because "try again" reads as a fluke otherwise. The refused
 * paths themselves stay in the log: they are model-supplied strings and listing
 * `../../.env` back in the transcript helps nobody.
 */
export const STREAM_REJECTED_PATHS_MESSAGE =
  'The AI finished without producing any files we could save — every file it named had an unsafe path. Try again.';

/**
 * The all-refused failure when at least one refusal was about content, not the
 * name — a binary payload, a file over the cap, a broken package.json. Saying
 * "unsafe path" for those would send the user chasing the wrong fault.
 */
export const STREAM_REJECTED_FILES_MESSAGE =
  'The AI finished without producing any files we could save — every file it sent was rejected (too large, unreadable, or unsafe). Try again.';

/**
 * Last line of defence: no file is stored with a raw `NEED_IMAGE: …` sitting
 * in a `src`. Fulfilment only sees the files a run rewrote, so a token in an
 * untouched file — written before fulfilment worked, or left when an image
 * provider was down — would otherwise stay broken forever. This pass only
 * swaps in the inline placeholder, so it never spends image credits.
 */
function withoutRawImageTokens(files: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [path, content] of Object.entries(files)) {
    const leftovers = placeholderReplacements(content);
    const replaced = leftovers.length > 0 ? replaceNeedImageTokens(content, leftovers) : content;
    // `placeholderReplacements` can only replace what the parser recognised. A real
    // build asked for `| 3:4`, which the pattern did not match, and the literal
    // token shipped inside the user's `lib/site.ts`. The sweep is textual, so a
    // shape nobody anticipated still cannot reach storage.
    out[path] = sweepNeedImageTokens(replaced);
  }
  return out;
}

/**
 * Turn the model's `NEED_IMAGE: …` requests into real pictures before the site
 * is stored.
 *
 * The stack prompt tells the model to ask for images this way and promises
 * "the pipeline replaces NEED_IMAGE tokens with real asset URLs before files
 * are written". That step used to live in the apply route; when the route went
 * away nothing called it, so generated sites shipped with the literal token
 * sitting in `src` and every hero image was broken — in the preview and in the
 * deployed site.
 *
 * Never fatal: a site with a plain panel where a photo should be still beats
 * losing a finished build to an image provider that is down or unconfigured.
 */
async function resolveImages(input: {
  jobId: string;
  projectId: string;
  userId: string;
  files: Record<string, string>;
}): Promise<{ files: Record<string, string>; requested: number; fulfilled: number }> {
  try {
    const { fulfillNeedImages } = await import('@/lib/assets/fulfill');
    const resolved = await fulfillNeedImages({
      projectId: input.projectId,
      userId: input.userId,
      files: Object.entries(input.files).map(([path, content]) => ({ path, content })),
    });
    // A step that can silently produce nothing has to leave a number behind. The whole
    // post-stream pipeline used to log nothing at all, which is why "four images
    // requested, zero produced" was invisible on a run that otherwise looked perfect.
    log.info('generation.images_resolved', {
      jobId: input.jobId,
      projectId: input.projectId,
      source: 'files',
      requested: resolved.requested,
      fulfilled: resolved.fulfilled,
      unfulfilled: resolved.unfulfilled.length,
      reasons: resolved.unfulfilled.slice(0, 5).map((image) => image.reason),
    });
    return {
      files: Object.fromEntries(resolved.map((file) => [file.path, file.content])),
      requested: resolved.requested,
      fulfilled: resolved.fulfilled,
    };
  } catch (error) {
    logError('generation.images_resolve_failed', error, {
      jobId: input.jobId,
      projectId: input.projectId,
      files: Object.keys(input.files).length,
    });
    return { files: input.files, requested: 0, fulfilled: 0 };
  }
}

/** What the settle learned about this run's pictures, for the caller to report. */
export type SettledImages = {
  /** Tokens found inside generated files — the only pictures the settle pays for. */
  inFileRequested: number;
  inFileFulfilled: number;
  /**
   * Pictures the model described in prose instead of writing into a `src`. Counted and
   * reported; never bought. See {@link countReplyOnlyImageRequests}.
   */
  replyDescribed: number;
  /** In-file requests no provider could serve. */
  unfulfilled: number;
};

const NO_IMAGES: SettledImages = {
  inFileRequested: 0,
  inFileFulfilled: 0,
  replyDescribed: 0,
  unfulfilled: 0,
};

/**
 * Count the pictures the model asked for in its own words, and buy none of them.
 *
 * `fulfillNeedImages` rewrites tokens it finds inside file contents, so a request the
 * model wrote as prose has nothing to rewrite. Generating one anyway produced a
 * `ProjectAsset` row and nothing else: no `<img>`, no `next/image`, no `backgroundImage`
 * anywhere in the site pointed at it. `attemptGeneration` treats a run as paid whenever
 * no image worker is configured — and `docker-compose.yml` defaults `IMAGE_WORKER_URL` to
 * empty, so the paid provider is the default deployment path — which made the settle debit
 * up to six image credits per build for pictures the page did not reference. The user was
 * then told the pictures existed and to ask for them to be placed, which costs another
 * generation. Before that, the same build produced no images and cost nothing; a page with
 * no photographs is a smaller failure than a page with no photographs and a bill.
 *
 * So the fix is to stop paying, not to stop noticing: the count still reaches the log and
 * the chat notice, because deleting the request silently is the other failure — the person
 * asked for a cafe page, four photographs were requested, and nothing anywhere said why
 * there are none. Parsing is pure and free (`parseNeedImageDirectives` reads text), and
 * `'prose'` is the right context because a reply is not a file: a directive ends at the
 * end of its line and an apostrophe in `a barista's hands pouring chai | 1:1` is part of
 * the subject.
 *
 * `inFileContents` is the reply's file bodies, parsed here and deduped on the same
 * `needImageKey` fulfilment uses: a picture asked for in both places was placed and paid
 * for once, and counting it here as "described but not created" would be a false alarm
 * about a picture that is on the page. The caller used to run that parse itself, in the
 * argument list — outside this function's try, and so outside the promise the catch below
 * makes: that counting is cosmetic and cannot cost a build. It ran between the merged-site
 * write and `succeedJob`, so anything it threw lost a build that was already stored.
 * Taking the bodies rather than the directives puts the whole count under one guard, and
 * behind the early return — a reply naming no picture no longer parses every file it wrote
 * to build a set it would not have read.
 */
async function countReplyOnlyImageRequests(input: {
  jobId: string;
  projectId: string;
  replyText: string;
  inFileContents: readonly string[];
}): Promise<number> {
  if (!input.replyText.includes('NEED_IMAGE:')) return 0;
  try {
    const { needImageKey, parseNeedImageDirectives: parse } = await import(
      '@/lib/assets/need-image'
    );
    const handled = new Set(parse(input.inFileContents.join('\n')).map(needImageKey));
    const described = parse(input.replyText, 'prose').filter(
      (directive) => !handled.has(needImageKey(directive)),
    );
    if (described.length === 0) return 0;
    log.info('generation.images_described_not_created', {
      jobId: input.jobId,
      projectId: input.projectId,
      source: 'reply',
      described: described.length,
      // The subjects, so an operator can see what the model keeps mis-placing. The
      // long-term fix is upstream — the model re-emitting the token in the `src` — and
      // this line is how anyone can tell whether it is working.
      subjects: described.slice(0, 5).map((directive) => directive.description),
    });
    return described.length;
  } catch (error) {
    // Counting is cosmetic; a build that finished must not be lost to it.
    logError('generation.images_from_reply_failed', error, {
      jobId: input.jobId,
      projectId: input.projectId,
    });
    return 0;
  }
}

/**
 * What chat is told about pictures the model described but did not place.
 *
 * `imageFulfilmentNotice` (lib/assets/fulfill.ts) owns the sentence for a picture that
 * was created and the sentence for one a provider refused; neither is this. Saying they
 * "have been created and added to Assets" is what the settle used to do, and it was true
 * only because it had just paid for them. This says what happened and what to do, and
 * promises only what the code can do: a `NEED_IMAGE:` token written into a `src` is
 * fulfilled by `resolveImages` on the next settle.
 */
export function replyDescribedImagesNotice(count: number): string | null {
  if (count <= 0) return null;
  return count === 1
    ? 'The AI described 1 image in its reply instead of placing it on the page, so it was not created. Ask for it on the page and the next build will generate it.'
    : `The AI described ${count} images in its reply instead of placing them on the page, so they were not created. Ask for them on the page and the next build will generate them.`;
}

/**
 * Start the code and SEO scans the moment a build settles.
 *
 * Both subsystems worked and neither had a caller: after two successful builds a
 * verified project answered `{"audit":null,"scanning":false,"hasFiles":true}` on
 * both endpoints, so a user who never opened the Quality tab got no signal that
 * anything had been checked. This only makes the scan *run* — publish gating is
 * untouched, exactly as it was.
 *
 * It goes through `runAutoCodeAudit` / `runAutoSeoAudit`, not the Scan button's
 * `runCodeAudit` / `runSeoAudit`, and the difference is the whole point. The manual
 * actions take the project lock and charge an audit credit. Round 1 called them from
 * here, and both halves of that were wrong: they also held the project's one live job
 * row (`one_active_job_per_project`), so the very next chat message was answered "A
 * build is already running on this project" for a build that had finished, and the
 * automatic build-fix loop got the same refusal and reported "The automatic build fix
 * produced no changes"; and the credit was spent on work nobody asked for, so a plan
 * allowing 20 audits a month ran out after 20 chat turns and the user's own Scan button
 * then failed with "credits used up". The auto twins hold nothing and charge nothing,
 * and record a settled AUDIT row apiece when they are done so a scan that failed still
 * reaches /admin/jobs and the Quality panel.
 *
 * They also run only the static half. Everything an automatic scan runs has to be free
 * and fast, because it runs on every settled build and nobody asked for it: the AI code
 * review is a paid provider call carrying up to 40 000 input tokens of the user's source,
 * and the axe and Lighthouse passes each fork a Chromium the production image does not
 * ship. Those three stay behind the Scan button.
 *
 * What each scan then has left to say differs, and the two are no longer symmetric. The
 * SEO half still does real work with no runner — `runSeoChecks` reads the files and the
 * live document — so it writes its row and announces Lighthouse as not yet run. The code
 * half's static checks all need a build runner this instance does not have, so on this
 * deployment it reaches a verdict about nothing and `performCodeAudit` stores no
 * `CodeAudit` row: an audit whose entire content is "typescript check could not run" six
 * times over is not a quality signal, and stored as one it read on the Quality panel as a
 * completed audit with a clean scorecard and filled the operator's recurring-issues panel
 * with the platform's own gaps. The call stays because that is a property of the
 * deployment, not of the code: a runner appears and the same call starts storing findings.
 *
 * They are `'use server'` exports that resolve their actor through `peekActor()`
 * before falling back to `getSessionUser()`, and this runs detached from the
 * request, past the point where reading cookies is safe. `runWithActor` supplies
 * the job's own user so the ownership check answers from the same identity that
 * paid for the build. The user row is re-read rather than trusted from the job, so
 * a deactivated account cannot keep starting AI reviews through a queued build.
 *
 * The job id travels with the call as the scan's warrant: unmetered work behind an
 * endpoint anyone can post to would otherwise be a free-scan button, so each action
 * insists on a build of this project that really did succeed, recently, and has not
 * been scanned since (`findRecentlySucceededBuild`).
 *
 * The AUDIT rows those actions leave behind are newer than the build that kicked them —
 * `insertSettledJob` stamps `createdAt` with the scan's `startedAt` — so they must never
 * be what a chat-side lookup answers with. `GET /api/projects/[id]/job` and
 * `resolveRecoveryTarget` both go through `getLatestChatJob`, which asks the database for
 * the chat kinds only; a kind-blind "newest row" there turned a failed scan into a failed
 * build and left the chat with no building indicator for every message after it.
 */
async function kickQualityScans(input: {
  jobId: string;
  projectId: string;
  userId: string;
}): Promise<void> {
  const owner = await prisma.user.findUnique({
    where: { id: input.userId },
    select: { id: true, email: true, name: true, role: true, avatarUrl: true, isActive: true },
  });
  if (!owner || !owner.isActive) {
    log.warn('generation.quality_scans_skipped', {
      jobId: input.jobId,
      projectId: input.projectId,
      reason: owner ? 'user is not active' : 'user not found',
    });
    return;
  }
  const actor = {
    id: owner.id,
    email: owner.email,
    name: owner.name,
    role: owner.role,
    avatarUrl: owner.avatarUrl,
  };
  const { runWithActor } = await import('@/lib/projects/plan');
  const [audit, seo] = await Promise.all([
    import('@/lib/audit/actions'),
    import('@/lib/seo/actions'),
  ]);

  // Sequential rather than parallel only so the two file-readiness reads do not land
  // together; neither run waits for the other's work. They now write separate job rows,
  // so the SEO scan can no longer adopt the code scan's row and replace its `steps` and
  // `currentStep` — the defect that made a failing code scan readable as an SEO failure
  // in one panel and as nothing at all in the other.
  const outcome = await runWithActor(actor, async () => {
    const code = await audit
      .runAutoCodeAudit(input.projectId, input.jobId)
      .then((r) => (r.ok ? (r.data.scanning ? 'started' : 'nothing to scan') : r.error));
    const seoOutcome = await seo
      .runAutoSeoAudit(input.projectId, input.jobId)
      .then((r) => (r.ok ? (r.data.scanning ? 'started' : 'nothing to scan') : r.error));
    return { code, seo: seoOutcome };
  });

  log.info('generation.quality_scans_kicked', {
    jobId: input.jobId,
    projectId: input.projectId,
    code: outcome.code,
    seo: outcome.seo,
  });
}

/** A concurrent writer kept winning the compare-and-set; the merge is not lost, only unsaved. */
const MAX_SITE_WRITE_ATTEMPTS = 5;

/**
 * Merge `files` over the current site and bump `contentVersion`, in one guarded
 * statement.
 *
 * The write and the version bump used to be two statements with no compare-and-set. An
 * `await resolveImages(...)` — a call out to an image provider that can take many
 * seconds — sits between the read of `lastCode` and this write, so a concurrent writer
 * (checkpoint restore, keep-partial, import persist) landing in that window was
 * overwritten wholesale, and a crash between the two statements left new code carrying a
 * stale version so the stale-view banner never fired for other viewers (F-044). The
 * project lock mostly serialises this, but `acquireLock` is re-entrant for one user by
 * design, so two operations by the same person are not serialised by it.
 *
 * `seen` is the reading the caller merged onto. The update only lands if the row still
 * carries that `contentVersion`; a writer that slipped in first makes `count` zero, so
 * we re-read and merge `files` onto the base that actually won — nobody's write is lost.
 */
export async function writeMergedSite(
  projectId: string,
  files: Record<string, string>,
  seen: { lastCode: string | null; contentVersion: number },
  /**
   * Paths the turn deleted, removed after the merge.
   *
   * Applied inside the retry loop, not before it: a losing compare-and-set
   * re-merges onto whatever base won, and a deletion that was applied only to
   * the first attempt's map would silently come back.
   */
  deletedPaths: readonly string[] = [],
): Promise<void> {
  let base = seen;
  for (let attempt = 0; attempt < MAX_SITE_WRITE_ATTEMPTS; attempt += 1) {
    const existing = getCurrentProjectFiles({ lastCode: base.lastCode });
    const merged = withoutRawImageTokens({ ...existing, ...files });
    for (const path of deletedPaths) delete merged[path];
    const { count } = await prisma.project.updateMany({
      where: { id: projectId, contentVersion: base.contentVersion },
      data: {
        lastCode: toLastCode(merged),
        contentVersion: { increment: 1 },
        // Files present is the whole condition for reaching this write, so the site is
        // finished — COMPLETE is always correct here.
        phase: 'COMPLETE',
      },
    });
    if (count > 0) return;
    const fresh = await prisma.project.findUnique({
      where: { id: projectId },
      select: { lastCode: true, contentVersion: true },
    });
    if (!fresh) throw new Error(`Project ${projectId} vanished while saving its site`);
    base = fresh;
  }
  throw new Error(
    'Another change to this project kept landing first, so this build was not saved. Try again.',
  );
}

export type StreamSettleInput = {
  jobId: string;
  producedFiles: number;
  /** The raw streamed text (`<file path=…>` blocks). The server holds the
   *  complete site the moment the stream ends — persistence must not depend
   *  on the browser tab surviving to send its own PATCH. */
  streamedCode?: string | null;
  /**
   * The files the tool path produced, keyed by path.
   *
   * When present this replaces parsing `streamedCode`, because on the tool path
   * there is nothing to parse: the reply is prose and every file arrived through
   * a validated `write_file` call. Deliberately *not* solved by synthesising a
   * fake fenced reply to feed the existing parser — the stored shape is `<file>`
   * blocks either way, and a fabricated reply string would be a second
   * representation of the same files to keep in step.
   *
   * Everything downstream is unchanged: `safeGeneratedFiles`, `resolveImages`,
   * `writeMergedSite` and `toLastCode` all take a map.
   */
  producedFileMap?: Record<string, string> | null;
  /**
   * Paths the tool path deleted this turn, via `delete_file` or the second half
   * of a `rename_file`.
   *
   * Separate from {@link StreamSettleInput.producedFileMap} because that map is
   * `Record<string, string>` where a key means "store this content" — an empty
   * string is a legal file, so an empty-string sentinel would make a deletion
   * and an emptied file the same value.
   */
  deletedPaths?: string[] | null;
  noChangeReason?: string | null;
  /** Initial build produced files that can't render on the project's stack. */
  stackMismatchReason?: string | null;
  tokensIn?: number;
  tokensOut?: number;
  estimatedCostUsd?: number | null;
  provider?: string | null;
  model?: string | null;
};

export type StreamSettleResult = {
  outcome: 'succeeded' | 'failed';
  errorCode?: string;
  errorMessage?: string;
  /**
   * Files the persist guard refused while the rest of the batch was stored —
   * an oversized file, a binary payload, a broken package.json. Present only
   * on a succeeded settle; a batch with nothing storable fails instead. The
   * route reports these through the same warning frame applyOutcome uses for
   * write misses, so a refused file is never a silent drop.
   */
  rejectedFiles?: RejectedGeneratedFile[];
  /** Counts for the log and for {@link StreamSettleResult.imageNotice}. */
  images?: SettledImages;
  /**
   * One plain-English sentence for chat when pictures were requested and either could
   * not be produced or were described in the reply instead of placed on the page. Null
   * when there is nothing to say. The `NEED_IMAGE:` lines that used to carry this
   * information into the transcript are stripped from it now, so this is what replaces
   * them — the protocol goes, the fact does not.
   */
  imageNotice?: string | null;
};

/**
 * Terminal settle for generate-ai-code-stream after the model finished.
 *
 * Streamed `<file>` blocks are not a finished site. Succeeding here used to
 * mark the job SUCCEEDED and the project COMPLETE while lastCode and
 * checkpoints were still empty — the sandbox had failed at ready, persist
 * never ran, and chat said Generation complete.
 */
export async function settleStreamedGeneration(
  input: StreamSettleInput,
): Promise<StreamSettleResult> {
  const job = await getJob(input.jobId);
  if (!job) {
    return { outcome: 'failed', errorCode: 'provider_error', errorMessage: 'Job not found' };
  }
  if (job.status !== 'QUEUED' && job.status !== 'RUNNING') {
    return {
      outcome: job.status === 'SUCCEEDED' ? 'succeeded' : 'failed',
      errorCode: job.errorCode ?? undefined,
      errorMessage: job.errorMessage ?? undefined,
    };
  }

  const usage = {
    tokensIn: input.tokensIn,
    tokensOut: input.tokensOut,
    estimatedCostUsd: input.estimatedCostUsd,
    provider: input.provider,
    model: input.model,
  };

  if (input.noChangeReason) {
    await failJob(job.id, {
      errorCode: 'no_files_generated',
      errorMessage: input.noChangeReason,
      ...usage,
    });
    return {
      outcome: 'failed',
      errorCode: 'no_files_generated',
      errorMessage: input.noChangeReason,
    };
  }

  // Files that can't render on the project's stack (Next.js output for a Vite
  // project, say) must not be persisted as the site: the sandbox boot would
  // run npm install into a tree with no scaffold and die, after chat already
  // said Generation complete.
  if (input.stackMismatchReason) {
    await failJob(job.id, {
      errorCode: 'stack_mismatch',
      errorMessage: input.stackMismatchReason,
      ...usage,
    });
    return {
      outcome: 'failed',
      errorCode: 'stack_mismatch',
      errorMessage: input.stackMismatchReason,
    };
  }

  const project = await prisma.project.findUnique({
    where: { id: job.projectId },
    select: { lastCode: true, contentVersion: true },
  });
  const checkpointCount = await prisma.checkpoint.count({ where: { projectId: job.projectId } });
  let hasSite = Boolean(project?.lastCode) || checkpointCount > 0;

  // The stream is the source of the site — persist it here, server-side.
  // Before this, lastCode was only written by the browser's terminal PATCH,
  // so a closed tab (or a sandbox stuck mid-boot) lost a fully generated
  // site while the job read SUCCEEDED with lastCode empty.
  //
  // The model replies in fenced blocks; lastCode is stored as <file> blocks,
  // which is what getCurrentProjectFiles reads. Convert here rather than
  // storing the raw reply, or the prose around the fences becomes part of the
  // site and the preview has nothing it can parse.
  // On the tool path the files came from validated `write_file` calls, so there
  // is nothing to parse out of the reply — and parsing it would find nothing,
  // because the reply is prose by contract.
  const replyFiles = input.producedFileMap ?? filesFromReply(input.streamedCode || '');
  const { safe: streamedFiles, rejected } = safeGeneratedFiles(replyFiles);
  if (rejected.length > 0) {
    log.warn('generation.settle_rejected_files', {
      jobId: job.id,
      projectId: job.projectId,
      count: rejected.length,
      paths: rejected.slice(0, 10).map((file) => file.path),
      codes: rejected.slice(0, 10).map((file) => file.code),
    });
    // Everything refused means nothing gets written — and on a project that already has a
    // site `hasSite` is already true, so the run used to skip the write block, skip the
    // no-files failure below, and reach succeedJob. Chat then reported the change as made
    // while lastCode had not moved, with only this log line recording it. A reply whose
    // files were all refused produced no file we could save, which is that same failure.
    // The copy distinguishes bad names from bad content, or a lone binary file would be
    // reported as an "unsafe path" the user can never find.
    if (Object.keys(streamedFiles).length === 0) {
      const allPathRefusals = rejected.every((file) => PATH_REJECTION_CODES[file.code]);
      const errorMessage = allPathRefusals
        ? STREAM_REJECTED_PATHS_MESSAGE
        : STREAM_REJECTED_FILES_MESSAGE;
      await failJob(job.id, {
        errorCode: 'no_files_generated',
        errorMessage,
        ...usage,
      });
      return {
        outcome: 'failed',
        errorCode: 'no_files_generated',
        errorMessage,
      };
    }
  }

  const images: SettledImages = { ...NO_IMAGES };
  // Deletions count as work: a turn that only removed a file has no written
  // file, and gating on writes alone would skip the persist and leave the file
  // on disk while chat reported it gone. `hasSite` is already true in that case
  // — there is no way to delete from a project that has no site — so the
  // no-files failure below stays correct without special-casing.
  const deletedPaths = input.deletedPaths ?? [];
  if (Object.keys(streamedFiles).length > 0 || deletedPaths.length > 0) {
    const resolved = await resolveImages({
      jobId: job.id,
      projectId: job.projectId,
      userId: job.userId,
      files: streamedFiles,
    });
    images.inFileRequested = resolved.requested;
    images.inFileFulfilled = resolved.fulfilled;
    images.unfulfilled += resolved.requested - resolved.fulfilled;
    // Merge over what is already there, never replace it. An edit returns only the files
    // it changed — storing just those would delete the rest of the site. The write and
    // the version bump are one guarded statement (writeMergedSite), keyed on the
    // `contentVersion` read above so a writer that slipped in during resolveImages is not
    // silently overwritten. `project` is non-null here: reaching this write means the row
    // exists (it was read above and a concurrent delete would fail the update, not this).
    await writeMergedSite(
      job.projectId,
      resolved.files,
      {
        lastCode: project?.lastCode ?? null,
        contentVersion: project?.contentVersion ?? 0,
      },
      deletedPaths,
    );
    hasSite = true;
    // The merged-site write is the step that turns a stream into the product, and it
    // logged nothing — so a run that stored eleven files and a run that stored none
    // looked identical from outside.
    log.info('generation.site_merged', {
      jobId: job.id,
      projectId: job.projectId,
      files: Object.keys(resolved.files).length,
      deleted: deletedPaths.length,
      rejected: rejected.length,
    });
  }

  // A stream that produced no parseable file leaves nothing to show. Saying
  // "complete" here is how a job used to read SUCCEEDED with lastCode empty.
  if (!hasSite) {
    await failJob(job.id, {
      errorCode: 'no_files_generated',
      errorMessage: STREAM_NO_FILES_MESSAGE,
      ...usage,
    });
    return {
      outcome: 'failed',
      errorCode: 'no_files_generated',
      errorMessage: STREAM_NO_FILES_MESSAGE,
    };
  }

  // Deliberately after the failure branches: a build that is about to fail is not worth
  // telling anyone about its pictures. `replyFiles`, not `streamedFiles` — a token inside
  // a file the guard refused was still asked for *in a file*, so it is not a prose-only
  // request and must not be reported as one.
  images.replyDescribed = await countReplyOnlyImageRequests({
    jobId: job.id,
    projectId: job.projectId,
    replyText: input.streamedCode || '',
    inFileContents: Object.values(replyFiles),
  });

  await succeedJob(job.id, usage);

  // Detached on purpose and only after `succeedJob`: the build is finished and a scan
  // that throws must not unwind it, and the scan's warrant is a build row that has
  // already settled SUCCEEDED — asking before the terminal write is asking too early.
  // Never bare `void`: a rejection with no project id and no task name is a failure
  // nobody can find (the same lesson `detachAfterGeneration` was written for).
  void kickQualityScans({
    jobId: job.id,
    projectId: job.projectId,
    userId: job.userId,
  }).catch((error: unknown) => {
    logError('generation.quality_scans_failed', error, {
      jobId: job.id,
      projectId: job.projectId,
      task: 'quality_scans',
    });
  });

  return {
    outcome: 'succeeded',
    ...(rejected.length > 0 ? { rejectedFiles: rejected } : {}),
    images,
    imageNotice: await imageNoticeFor(job.id, job.projectId, images),
  };
}

/**
 * The chat sentence, fetched without letting a module load unwind a finished build.
 *
 * This runs after `succeedJob`, so a bare `await import(…)` that failed would throw
 * out of a settle that has already succeeded and the route would report a stored
 * site as a settle failure. The notice is copy — it cannot be worth that. The
 * early return also keeps the image graph unloaded on a settle that had no
 * pictures at all.
 *
 * Two sentences, from two owners. `imageFulfilmentNotice` speaks for the pictures a
 * provider was asked for and could not produce; `replyDescribedImagesNotice` speaks for
 * the ones the model described but never placed, which are not a provider failure and are
 * no longer bought. `fromReply: 0` is not a placeholder — nothing on this path creates a
 * picture from the reply any more, so there is never a "created and added to Assets"
 * count to pass, and passing one would be a claim about assets that do not exist.
 */
async function imageNoticeFor(
  jobId: string,
  projectId: string,
  images: SettledImages,
): Promise<string | null> {
  const described = replyDescribedImagesNotice(images.replyDescribed);
  if (images.unfulfilled === 0) return described;
  try {
    const { imageFulfilmentNotice } = await import('@/lib/assets/fulfill');
    const unfulfilled = imageFulfilmentNotice({ fromReply: 0, unfulfilled: images.unfulfilled });
    return [described, unfulfilled].filter(Boolean).join(' ') || null;
  } catch (error) {
    logError('generation.image_notice_failed', error, { jobId, projectId });
    return described;
  }
}
