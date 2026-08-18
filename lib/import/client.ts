import { IMPORT_NO_FILES_MESSAGE } from './copy.ts';

export type ImportStreamComplete = {
  filesXml: string;
  warnings: string[];
  usedFallback: boolean;
  sourceUrl: string;
  mode: string;
};

/**
 * SSE `error` frames and some HTTP bodies use `{ error: { message, code, requestId } }`.
 * Older 400s still send `{ error: '…' }`. Reading either as a string produced
 * `[object Object]` in chat.
 */
export function readImportErrorMessage(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return 'Import failed';
  const row = payload as Record<string, unknown>;
  const nested = row.error;
  if (typeof nested === 'string' && nested.trim()) return nested;
  if (nested && typeof nested === 'object') {
    const message = (nested as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message;
  }
  if (typeof row.message === 'string' && row.message.trim()) return row.message;
  return 'Import failed';
}

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
    const denial = data as { message?: string; error?: unknown; reason?: string; used?: number; limit?: number };
    const error = new Error(readImportErrorMessage(data)) as Error & {
      creditDenial?: { reason: string; used: number; limit: number; message: string };
    };
    if (response.status === 409) {
      const { emitLockConflict, parseLockConflict } = await import('@/lib/projects/lock-client');
      const conflict = parseLockConflict(409, data);
      if (conflict) emitLockConflict(conflict);
    }
    if (response.status === 402 && denial.message) {
      error.creditDenial = {
        reason: String(denial.reason || 'workspace_exhausted'),
        used: typeof denial.used === 'number' ? denial.used : 0,
        limit: typeof denial.limit === 'number' ? denial.limit : 0,
        message: denial.message,
      };
    }
    throw error;
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
        error?: unknown;
        filesXml?: string;
        warnings?: string[];
        usedFallback?: boolean;
        sourceUrl?: string;
        mode?: string;
      };
      if (payload.type === 'progress' && payload.message) {
        input.onProgress?.(payload.message);
      } else if (payload.type === 'error') {
        errorMessage = readImportErrorMessage(payload);
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
  if (!complete) throw new Error(IMPORT_NO_FILES_MESSAGE);
  return complete;
}
