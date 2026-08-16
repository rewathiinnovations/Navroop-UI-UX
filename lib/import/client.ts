export type ImportStreamComplete = {
  filesXml: string;
  warnings: string[];
  usedFallback: boolean;
  sourceUrl: string;
  mode: string;
};

export async function streamProjectImport(input: {
  projectId: string;
  sourceUrl: string;
  mode?: string;
  onProgress?: (message: string) => void;
}): Promise<ImportStreamComplete> {
  const response = await fetch(`/api/projects/${input.projectId}/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sourceUrl: input.sourceUrl, mode: input.mode }),
  });
  if (!response.ok || !response.body) {
    const data = await response.json().catch(() => ({}));
    throw new Error(String((data as { error?: string }).error || 'Import failed'));
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let complete: ImportStreamComplete | null = null;
  let errorMessage = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split('\n\n');
    buffer = chunks.pop() ?? '';
    for (const chunk of chunks) {
      const line = chunk.split('\n').find((entry) => entry.startsWith('data: '));
      if (!line) continue;
      const payload = JSON.parse(line.slice(6)) as {
        type?: string;
        message?: string;
        error?: string;
        filesXml?: string;
        warnings?: string[];
        usedFallback?: boolean;
        sourceUrl?: string;
        mode?: string;
      };
      if (payload.type === 'progress' && payload.message) {
        input.onProgress?.(payload.message);
      } else if (payload.type === 'error') {
        errorMessage = payload.error || 'Import failed';
      } else if (payload.type === 'complete' && payload.filesXml) {
        complete = {
          filesXml: payload.filesXml,
          warnings: payload.warnings ?? [],
          usedFallback: Boolean(payload.usedFallback),
          sourceUrl: payload.sourceUrl || input.sourceUrl,
          mode: payload.mode || input.mode || 'reimagine',
        };
      }
    }
  }

  if (errorMessage) throw new Error(errorMessage);
  if (!complete) throw new Error('Import produced no files');
  return complete;
}
