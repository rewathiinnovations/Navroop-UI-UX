import type { GenerationJobRow, PartialFile } from './types';

export function shouldResumePartial(
  job: Pick<GenerationJobRow, 'kind' | 'attempt' | 'maxAttempts' | 'filesWritten'> & {
    errorCode?: string | null;
  },
) {
  // A stack_mismatch build's partials are the poison (wrong-framework files);
  // telling the retry they "were already written and must not be regenerated"
  // makes the model either refuse or keep building on the wrong layout.
  // Those retries start clean from the plan.
  if (job.errorCode === 'stack_mismatch') return false;
  return job.kind === 'BUILD' && job.filesWritten > 0 && job.attempt < job.maxAttempts;
}

export function buildResumePrompt(input: {
  originalPrompt: string;
  planContext?: string | null;
  writtenFiles: PartialFile[];
}) {
  const written = input.writtenFiles.map((file) => `- ${file.path}`).join('\n');
  return [
    input.planContext?.trim() || '',
    input.originalPrompt.trim(),
    'The previous build was interrupted. These files were already written and must not be regenerated:',
    written || '- (none)',
    'Produce only the remaining files. Do not rewrite files listed above unless a remaining file cannot compile without a tiny import fix.',
  ]
    .filter(Boolean)
    .join('\n\n');
}
