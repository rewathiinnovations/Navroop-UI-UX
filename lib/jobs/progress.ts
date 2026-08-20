import { log } from '@/lib/logger';
import { PROGRESS_BATCH_MS } from './poll';
import { applyJobFields, getJob } from './store';
import type { PartialFile } from './types';

/**
 * Batches a running build's partial files onto its `Job` row.
 *
 * `partialFiles` is a jsonb array, so a write always carries the whole set —
 * that part is unavoidable. What was avoidable was doing it every two seconds
 * for the whole build whether or not anything had changed: the pending map was
 * never cleared, so every flush re-sent every file it had ever seen, re-read the
 * row first to merge, and then `updateJobFields` read it back again. Three round
 * trips and ~2× the project's bytes, twice a second, on a 40-file build (F-034).
 *
 * Now: the row is read once to pick up files an earlier attempt left behind,
 * pending files are cleared after a successful write, a flush with nothing new
 * writes nothing, and `setStep` persists on its own instead of only ever riding
 * along with a file.
 */
export type ProgressBatcher = {
  /** Records a file this run streamed; scheduled, not written immediately. */
  addFile(path: string, content: string): void;
  /** Records what the run is doing now — persisted whether or not a file follows. */
  setStep(step: string): void;
  /** Drains everything pending. Awaited before a job is settled or abandoned. */
  flush(): Promise<void>;
};

export function createProgressBatcher(
  jobId: string,
  intervalMs = PROGRESS_BATCH_MS,
): ProgressBatcher {
  /** Files written since the last successful flush. */
  const pending = new Map<string, string>();
  /**
   * Everything already on the row, so a flush never has to read it back. Null
   * until the first flush needs it — a resumed attempt can find files from an
   * earlier one there, and dropping them would shrink what "Keep what was
   * built" can recover.
   */
  let persisted: Map<string, string> | null = null;
  let lastStep: string | null = null;
  let persistedStep: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let flushing: Promise<void> = Promise.resolve();

  const flush = async () => {
    const hasFiles = pending.size > 0;
    if (!hasFiles && lastStep === persistedStep) return;

    const step = lastStep;
    if (!hasFiles) {
      // A step with no new file is still worth recording: `lastStep` is what the
      // recovery copy and /admin/jobs read, and it used to be written only when
      // a file happened to be flushed with it.
      await applyJobFields(jobId, { lastStep: step });
      persistedStep = step;
      return;
    }

    if (persisted === null) {
      const job = await getJob(jobId);
      persisted = new Map((job?.partialFiles ?? []).map((file) => [file.path, file.content]));
    }
    const draining = [...pending];
    for (const [path, content] of draining) persisted.set(path, content);
    const partialFiles: PartialFile[] = [...persisted].map(([path, content]) => ({
      path,
      content,
    }));
    await applyJobFields(jobId, {
      partialFiles,
      filesWritten: partialFiles.length,
      lastStep: step,
    });

    // Only after the write lands. A failed flush has to leave the work queued,
    // and a file rewritten while this one was in flight must stay pending.
    for (const [path, content] of draining) {
      if (pending.get(path) === content) pending.delete(path);
    }
    persistedStep = step;
  };

  const schedule = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      flushing = flushing.then(flush).catch((error) => {
        log.warn('jobs.progress_flush_failed', {
          jobId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, intervalMs);
    timer.unref?.();
  };

  return {
    addFile(path: string, content: string) {
      pending.set(path, content);
      lastStep = path;
      schedule();
    },
    setStep(step: string) {
      lastStep = step;
      schedule();
    },
    async flush() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      await flushing;
      await flush();
    },
  };
}
