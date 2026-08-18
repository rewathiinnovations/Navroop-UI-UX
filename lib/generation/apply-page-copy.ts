import { applyOutcome } from '@/lib/jobs/copy';

/**
 * Chat and log copy after startApply on the generation page.
 *
 * Delegates to applyOutcome so the page cannot invent a second success
 * sentence. Preview / package errors stay on their own frames — they are
 * not file-write failures.
 */
export function applyPageCopy(input: {
  filesCreated?: readonly string[] | null;
  filesUpdated?: readonly string[] | null;
  errors?: readonly string[] | null;
}) {
  return applyOutcome({
    filesCreated: input.filesCreated ?? [],
    filesUpdated: input.filesUpdated ?? [],
    errors: input.errors ?? [],
  });
}

/** The stream already pushed this sentence as a warning — do not add it twice. */
export function shouldAddApplyChat(lastContent: string | undefined, message: string): boolean {
  return lastContent !== message;
}
