import { buildMemoryBlock } from '@/lib/memory/build-context';
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
  // Brain memory is always-on and belongs inside the cacheable prefix, including on the
  // import that produces the site's first version (F-107). Loaded once here, not per
  // section, so the prefix stays byte-identical. A failure to read it is logged and the
  // import continues without memory — same contract as the chat generation route.
  let memoryBlock = '';
  try {
    memoryBlock = (await buildMemoryBlock(input.projectId)).block;
  } catch (error) {
    console.warn('[import] memory block failed', error);
  }
  return runUrlImportPipeline({
    projectId: input.projectId,
    sourceUrl: input.sourceUrl,
    mode: input.mode,
    stack: input.stack,
    designDirection: input.designDirection,
    userId: input.userId,
    memoryBlock,
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
