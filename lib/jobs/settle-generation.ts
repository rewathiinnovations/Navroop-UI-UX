import { prisma } from '@/lib/db';
import { filesFromReply } from '@/lib/generation/parse-blocks';
import { placeholderReplacements, replaceNeedImageTokens } from '@/lib/assets/need-image';
import { getCurrentProjectFiles } from '@/lib/github/current-files';
import { toLastCode } from '@/lib/projects/last-code';
import { bumpContentVersion } from '@/lib/projects/lock';
import { failJob, succeedJob } from './lifecycle';
import { getJob } from './store';

export const STREAM_NO_FILES_MESSAGE =
  'The AI finished without producing any files we could save. Try again.';

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
    out[path] = leftovers.length > 0 ? replaceNeedImageTokens(content, leftovers) : content;
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
  const streamedFiles = filesFromReply(input.streamedCode || '');
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
  return { outcome: 'succeeded' };
}
