import { log } from '@/lib/logger';
import { PROGRESS_BATCH_MS } from './poll';
import { getJob, updateJobFields } from './store';
import type { PartialFile } from './types';

export function createProgressBatcher(jobId: string, intervalMs = PROGRESS_BATCH_MS) {
  const files = new Map<string, string>();
  let lastStep: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let flushing: Promise<void> = Promise.resolve();

  const flush = async () => {
    if (files.size === 0) return;
    const job = await getJob(jobId);
    const existing = new Map((job?.partialFiles ?? []).map((file) => [file.path, file.content]));
    for (const [path, content] of files) existing.set(path, content);
    const partialFiles: PartialFile[] = [...existing.entries()].map(([path, content]) => ({ path, content }));
    await updateJobFields(jobId, {
      partialFiles,
      filesWritten: partialFiles.length,
      lastStep,
    });
  };

  const schedule = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      flushing = flushing
        .then(flush)
        .catch((error) => {
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
      files.set(path, content);
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
