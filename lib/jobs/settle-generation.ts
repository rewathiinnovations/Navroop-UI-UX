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
import { log } from '@/lib/logger';
import { toLastCode } from '@/lib/projects/last-code';
import { bumpContentVersion } from '@/lib/projects/lock';
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
  projectId: string;
  userId: string;
  files: Record<string, string>;
}): Promise<Record<string, string>> {
  try {
    const { fulfillNeedImages } = await import('@/lib/assets/fulfill');
    const resolved = await fulfillNeedImages({
      projectId: input.projectId,
      userId: input.userId,
      files: Object.entries(input.files).map(([path, content]) => ({ path, content })),
    });
    return Object.fromEntries(resolved.map((file) => [file.path, file.content]));
  } catch (error) {
    console.warn(
      '[settle] image fulfilment failed, storing files unchanged:',
      error instanceof Error ? error.message : error,
    );
    return input.files;
  }
}

export type StreamSettleInput = {
  jobId: string;
  producedFiles: number;
  /** The raw streamed text (`<file path=…>` blocks). The server holds the
   *  complete site the moment the stream ends — persistence must not depend
   *  on the browser tab surviving to send its own PATCH. */
  streamedCode?: string | null;
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
    select: { lastCode: true, phase: true },
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
  const { safe: streamedFiles, rejected } = safeGeneratedFiles(
    filesFromReply(input.streamedCode || ''),
  );
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

  if (Object.keys(streamedFiles).length > 0) {
    const resolvedFiles = await resolveImages({
      projectId: job.projectId,
      userId: job.userId,
      files: streamedFiles,
    });
    // Merge over what is already there, never replace it. An edit returns only
    // the files it changed — storing just those would delete the rest of the
    // site. Writing at all is the point: this used to run only when the
    // project had no site yet, so every edit after the first build streamed
    // in, reported SUCCEEDED, and was thrown away. The chat said the change
    // was made and the site never moved.
    const existing = getCurrentProjectFiles({ lastCode: project?.lastCode ?? null });
    const merged = withoutRawImageTokens({ ...existing, ...resolvedFiles });
    await prisma.project.update({
      where: { id: job.projectId },
      data: {
        lastCode: toLastCode(merged),
        ...(project?.phase !== 'COMPLETE' ? { phase: 'COMPLETE' as const } : {}),
      },
    });
    await bumpContentVersion(job.projectId);
    hasSite = true;
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

  await succeedJob(job.id, usage);
  return { outcome: 'succeeded', ...(rejected.length > 0 ? { rejectedFiles: rejected } : {}) };
}
