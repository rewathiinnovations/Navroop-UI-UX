import { looksLikeUrl } from '../projects/prompt.ts';
import { IMPORT_NO_FILES_MESSAGE } from './copy.ts';
import { firecrawlFailureMessage } from './firecrawl.ts';
import { DEFAULT_IMPORT_MODE, resolveImportMode, type ImportMode } from './mode.ts';
import { IMPORT_PROGRESS, buildingSectionProgress, composingProgress } from './progress.ts';
import { normalizeSourceUrl } from './url.ts';
import type {
  GenerateSectionsResult,
  ImportSection,
  PageCapture,
  RehostResult,
  RehostedAsset,
  UrlImportResult,
} from './types.ts';

export function decideUrlImportFlow(input: {
  initialPrompt: string;
  skipPlanning?: boolean;
  importMode?: unknown;
}) {
  const isUrlImport = looksLikeUrl(input.initialPrompt);
  return {
    isUrlImport,
    skipPlanning: isUrlImport ? true : Boolean(input.skipPlanning),
    importMode: resolveImportMode(input.importMode) ?? DEFAULT_IMPORT_MODE,
    sourceUrl: isUrlImport ? normalizeSourceUrl(input.initialPrompt) : '',
  };
}

export type UrlImportDeps = {
  projectId: string;
  sourceUrl: string;
  mode: ImportMode;
  stack: string;
  designDirection: string;
  userId: string;
  capture?: () => Promise<PageCapture>;
  rehost?: (capture: PageCapture) => Promise<RehostResult>;
  segment?: (capture: PageCapture) => Promise<ImportSection[]>;
  generateSections?: (input: {
    capture: PageCapture;
    sections: ImportSection[];
    assets: RehostedAsset[];
    onProgress: (message: string) => void;
  }) => Promise<GenerateSectionsResult>;
  generateFallback?: (input: {
    capture: PageCapture;
    assets: RehostedAsset[];
  }) => Promise<GenerateSectionsResult>;
  persistSource?: (input: {
    capture: PageCapture;
    sections: ImportSection[];
    usedFallback: boolean;
  }) => Promise<void>;
  onProgress?: (message: string) => void;
  jobId?: string;
};

export async function runUrlImportPipeline(input: UrlImportDeps): Promise<UrlImportResult> {
  const onProgress = input.onProgress ?? (() => undefined);
  onProgress(IMPORT_PROGRESS.capturing);
  const capture = await (input.capture
    ? input.capture()
    : (await import('./capture.ts')).capturePage(input.sourceUrl, { userId: input.userId }));

  const warnings: string[] = [];
  const firecrawl = capture.firecrawl ?? { ok: true as const, markdown: capture.firecrawlText };
  if (!firecrawl.ok) {
    const message = firecrawlFailureMessage(firecrawl);
    warnings.push(message);
    onProgress(message);
    const { recordJobStepFailure } = await import('../jobs/step-failure.ts');
    await recordJobStepFailure(input.jobId, {
      key: 'firecrawl',
      label: 'Reading page text',
      error: message,
    });
  }

  onProgress(IMPORT_PROGRESS.extracting);
  const rehosted = await (input.rehost
    ? input.rehost(capture)
    : (await import('./rehost-assets.ts')).rehostImportAssets({
        projectId: input.projectId,
        userId: input.userId,
        images: capture.images,
      }));

  let sections: ImportSection[] = [];
  let usedFallback = false;
  let generated: GenerateSectionsResult;

  try {
    sections = await (input.segment
      ? input.segment(capture)
      : (await import('./segment.ts')).segmentPage({ capture, userId: input.userId }));
    if (!sections.length) throw new Error('No sections');

    generated = await (input.generateSections
      ? input.generateSections({
          capture,
          sections,
          assets: rehosted.assets,
          onProgress,
        })
      : (await import('./generate-sections.ts')).generateImportedSections({
          projectId: input.projectId,
          userId: input.userId,
          stack: input.stack,
          designDirection: input.designDirection,
          mode: input.mode,
          capture,
          sections,
          assets: rehosted.assets,
          onProgress,
          jobId: input.jobId,
        }));
  } catch (error) {
    console.warn('[import] segmentation failed, falling back to single-pass', error);
    usedFallback = true;
    onProgress(buildingSectionProgress(1, 1));
    generated = await (input.generateFallback
      ? input.generateFallback({ capture, assets: rehosted.assets })
      : (await import('./generate-sections.ts')).generateImportFallback({
          projectId: input.projectId,
          userId: input.userId,
          stack: input.stack,
          designDirection: input.designDirection,
          mode: input.mode,
          capture,
          assets: rehosted.assets,
        }));
  }

  if (!usedFallback && sections.length) {
    onProgress(composingProgress());
  }

  await input.persistSource?.({ capture, sections, usedFallback });

  warnings.push(...rehosted.warnings, ...(generated.warnings ?? []));
  const filesXml = generated.filesXml?.trim() ?? '';
  if (!filesXml) {
    throw new Error(IMPORT_NO_FILES_MESSAGE);
  }

  return {
    filesXml: generated.filesXml,
    sections,
    tokens: capture.tokens,
    assets: rehosted.assets,
    warnings,
    usedFallback,
    inputTokens: generated.inputTokens,
    sourceUrl: capture.sourceUrl,
    mode: input.mode,
  };
}
