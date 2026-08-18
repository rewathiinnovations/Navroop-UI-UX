import { persistProjectGeneration } from '@/lib/projects/actions';
import type { ImportMode } from './mode.ts';
import { runUrlImportPipeline } from './pipeline.ts';
import { upsertImportSource } from './persist.ts';
import type { UrlImportResult } from './types.ts';

export async function runProjectUrlImport(input: {
  projectId: string;
  userId: string;
  sourceUrl: string;
  mode: ImportMode;
  stack: string;
  designDirection: string;
  onProgress?: (message: string) => void;
  jobId?: string;
}): Promise<UrlImportResult> {
  return runUrlImportPipeline({
    projectId: input.projectId,
    sourceUrl: input.sourceUrl,
    mode: input.mode,
    stack: input.stack,
    designDirection: input.designDirection,
    userId: input.userId,
    jobId: input.jobId,
    persistSource: async ({ capture, sections }) => {
      await upsertImportSource({
        projectId: input.projectId,
        sourceUrl: capture.sourceUrl,
        mode: input.mode,
        designTokens: capture.tokens,
        sections,
        capturedAt: capture.capturedAt,
      });
    },
    onProgress: (message) => {
      input.onProgress?.(message);
      persistProjectGeneration(input.projectId, {
        generationStatus: 'generating',
        progressMessage: message,
      }).catch((error) => {
        console.warn('[import] progress persist failed', error);
      });
    },
  });
}
