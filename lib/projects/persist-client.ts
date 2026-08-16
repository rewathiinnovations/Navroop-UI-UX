import { projectDisplayName } from '@/lib/projects/prompt';

export type PersistProjectInput = {
  id?: string | null;
  title?: string;
  prompt: string;
  style?: string | null;
  model?: string | null;
  sandboxId?: string | null;
  previewUrl?: string | null;
  screenshot?: string | null;
  lastCode?: string | null;
  status?: string | null;
  progressMessage?: string | null;
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
    sandboxId: input.sandboxId,
    previewUrl: input.previewUrl,
    thumbnailUrl: input.screenshot,
    screenshot: input.screenshot,
    lastCode: input.lastCode,
    generationStatus: input.status,
    status: input.status,
    progressMessage: input.progressMessage,
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
  };
}
