import { projectDisplayName } from '@/lib/projects/prompt';

export type PersistProjectInput = {
  id?: string | null;
  title?: string;
  prompt: string;
  style?: string | null;
  model?: string | null;
  // No sandboxId: the column went with 20260819010000_drop_sandbox_columns, and
  // sending it anyway made every generation PATCH answer 500.
  previewUrl?: string | null;
  screenshot?: string | null;
  lastCode?: string | null;
  // No status / progressMessage — and this save was never the writer of either.
  // `saveCurrentProject`, its only caller, runs on the URL-import path to create the
  // row; a build's status came from `setJobStatus` in lib/generation/generation-runtime.ts,
  // which is where the repeating write was and where it was removed. What is left there
  // is one terminal PATCH per run, because `generationStatus: 'ready'` is what makes
  // `persistProjectGeneration` cut the checkpoint and build the preview. Progress itself
  // is the server's: `markJobRunning` writes `generating` onto the row,
  // `createProgressBatcher` writes the step and partial files onto the Job row, and the
  // workspace polls both back through GET /api/projects/{id}/job.
  sourceMessage?: string | null;
  source?: string | null;
};

export async function persistProject(input: PersistProjectInput) {
  const payload = {
    name: input.title,
    title: input.title,
    initialPrompt: input.prompt,
    prompt: input.prompt,
    style: input.style,
    model: input.model,

    previewUrl: input.previewUrl,
    thumbnailUrl: input.screenshot,
    screenshot: input.screenshot,
    lastCode: input.lastCode,
    sourceMessage: input.sourceMessage,
    source: input.source,
  };

  const response = await fetch(input.id ? `/api/projects/${input.id}` : '/api/projects', {
    method: input.id ? 'PATCH' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (response.status === 401) {
    return { saved: false as const, reason: 'unauthorized' as const };
  }

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || 'Could not save project');
  }

  const data = await response.json();
  const project = data.project;
  return {
    saved: true as const,
    project: {
      ...project,
      title: projectDisplayName(project),
    },
    previewNotice: typeof data.previewNotice === 'string' ? data.previewNotice : null,
  };
}
