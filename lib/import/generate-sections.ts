import sharp from 'sharp';
import { generateText } from 'ai';
import { chatModelForProvider } from '@/lib/ai/client-for-entry';
import { getProviderForModel } from '@/lib/ai/provider-manager';
import { RunUsage } from '@/lib/consumption/run-usage';
import { buildCachedMessages } from '@/lib/generation/prompt-cache';
import { recordJobStepFailure } from '@/lib/jobs/step-failure';
import { logGenerationEvent } from '@/lib/usage-costs';
import { buildStablePromptPrefix } from '@/lib/stack-prompts';
import { getStack } from '@/lib/stacks';
import { sectionGenerateFailureMessage, sectionGenerationSeverity } from './copy';
import type { ImportMode } from './mode';
import { buildingSectionProgress } from './progress';
import {
  buildCompositionVolatilePrompt,
  buildFallbackVolatilePrompt,
  buildSectionVolatilePrompt,
} from './prompts';
import { formatDesignTokens } from './tokens';
import type { GenerateSectionsResult, ImportSection, PageCapture, RehostedAsset } from './types';

export type ImportCompleteXml = (input: {
  stablePrefix: string;
  volatileUser: string;
  image?: Buffer;
  projectId: string;
  userId: string;
}) => Promise<{ text: string; inputTokens: number }>;

/**
 * Brain memory is documented as always-on and inside the cacheable prefix, but the import
 * path built its prefix without it, so durable preferences did not reach the generation
 * that produces the site's first version (F-107). It is loaded once per import and passed
 * in here rather than per section, which keeps the prefix byte-identical and cacheable.
 */
export function buildImportStablePrefix(
  stack: string,
  designDirection?: string | null,
  memoryBlock?: string | null,
) {
  return buildStablePromptPrefix(stack, designDirection, { memoryBlock });
}

export { buildSectionVolatilePrompt };

function slug(value: string) {
  const next = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  return next || 'section';
}

export function sectionComponentPath(stack: string, section: ImportSection) {
  const name = slug(section.label || section.id);
  const pascal = name
    .split('-')
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join('');
  switch (getStack(stack).id) {
    case 'NEXTJS':
      return `components/imported/${pascal}.tsx`;
    case 'REACT':
      return `src/components/${pascal}.jsx`;
    case 'STATIC_HTML':
      return `${name}.html`;
    default:
      return `components/${pascal}.tsx`;
  }
}

function compositionHint(stack: string) {
  switch (getStack(stack).id) {
    case 'NEXTJS':
      return 'Compose in app/page.tsx (and app/layout.tsx for nav/footer if needed).';
    case 'REACT':
      return 'Compose in src/App.jsx. Nav in Header.jsx when needed.';
    case 'STATIC_HTML':
      return 'Compose in index.html with relative links.';
    default:
      return 'Compose the stack entry file.';
  }
}

async function cropSection(desktopPng: Buffer, range: [number, number]) {
  const image = sharp(desktopPng, { failOn: 'none' });
  const meta = await image.metadata();
  const width = meta.width ?? 1440;
  const height = meta.height ?? 900;
  const top = Math.max(0, Math.min(height - 1, Math.round(range[0])));
  const bottom = Math.max(top + 1, Math.min(height, Math.round(range[1])));
  const cropHeight = Math.max(32, bottom - top);
  return image
    .extract({
      left: 0,
      top,
      width,
      height: Math.min(cropHeight, height - top),
    })
    .png()
    .toBuffer();
}

function assetsForSection(section: ImportSection, assets: RehostedAsset[]) {
  if (assets.length <= 3) return assets;
  const [start, end] = section.approximateYRange;
  const mid = (start + end) / 2;
  return assets
    .map((asset, index) => ({
      asset,
      score: Math.abs(index / assets.length - mid / Math.max(end, 1)),
    }))
    .sort((a, b) => a.score - b.score)
    .slice(0, 4)
    .map((entry) => entry.asset);
}

async function completeXml(input: {
  stablePrefix: string;
  volatileUser: string;
  image?: Buffer;
  projectId: string;
  userId: string;
}) {
  const { client, actualModel } = await getProviderForModel(null, input.userId);
  const cached = buildCachedMessages({
    stablePrefix: input.stablePrefix,
    volatileUser: input.volatileUser,
  });
  const messages = input.image
    ? [
        cached[0],
        {
          role: 'user' as const,
          content: [
            { type: 'text' as const, text: input.volatileUser },
            { type: 'image' as const, image: input.image },
          ],
        },
      ]
    : cached;

  const promptText = `${input.stablePrefix}\n${input.volatileUser}`;
  const spent = new RunUsage();
  spent.willSend(promptText);
  try {
    const result = await generateText({
      model: chatModelForProvider(client, actualModel),
      messages,
    });
    spent.settle(result.usage, result.text);
    return { text: result.text, inputTokens: spent.totals.tokensIn };
  } finally {
    // Two holes closed in one place. A section whose call threw is caught by the loop in
    // `generateImportedSections` and turned into a warning — it used to log no event at
    // all, so the failures that had already been billed reported nothing. And the event
    // now carries what it cost onto `Workspace.spendUsd`: nothing calls `recordJobUsage`
    // for an IMPORT job, so this row was the only record of the spend and the row alone
    // never moved the ceiling. If an IMPORT ever starts recording job usage, one of the
    // two has to stop accruing or one import will move the ceiling twice.
    const totals = spent.claim();
    if (totals) {
      console.info('[import] inputTokens', totals.tokensIn);
      await logGenerationEvent({
        projectId: input.projectId,
        userId: input.userId,
        kind: 'followup',
        isUrlClone: true,
        inputTokens: totals.tokensIn,
        outputTokens: totals.tokensOut,
        model: actualModel,
        accrueToSpendCeiling: true,
      });
    }
  }
}

function joinFilesXml(chunks: string[]) {
  return chunks
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .join('\n\n');
}

export async function generateImportedSections(input: {
  projectId: string;
  userId: string;
  stack: string;
  designDirection: string;
  mode: ImportMode;
  capture: PageCapture;
  sections: ImportSection[];
  assets: RehostedAsset[];
  /** ACTIVE workspace + project Brain memory, inside the cacheable prefix. */
  memoryBlock?: string | null;
  onProgress?: (message: string) => void;
  jobId?: string;
  complete?: ImportCompleteXml;
}): Promise<GenerateSectionsResult> {
  const complete = input.complete ?? completeXml;
  const stablePrefix = buildImportStablePrefix(
    input.stack,
    input.designDirection,
    input.memoryBlock,
  );
  const tokens = formatDesignTokens(input.capture.tokens);
  const files: string[] = [];
  const paths: { path: string; label: string }[] = [];
  const warnings: string[] = [];
  let inputTokens = 0;
  let failedSections = 0;

  for (const [index, section] of input.sections.entries()) {
    input.onProgress?.(buildingSectionProgress(index + 1, input.sections.length));
    const path = sectionComponentPath(input.stack, section);
    const crop = await cropSection(input.capture.desktopPng, section.approximateYRange).catch(
      () => input.capture.desktopPng,
    );
    const volatile = `${buildSectionVolatilePrompt({
      mode: input.mode,
      tokens,
      section,
      firecrawlText: input.capture.firecrawlText,
      assets: assetsForSection(section, input.assets),
      designDirection: input.designDirection,
    })}\n\nWrite the component to <file path="${path}">.`;
    try {
      const result = await complete({
        stablePrefix,
        volatileUser: volatile,
        image: crop,
        projectId: input.projectId,
        userId: input.userId,
      });
      inputTokens += result.inputTokens;
      files.push(result.text);
      paths.push({ path, label: section.label });
    } catch (error) {
      failedSections += 1;
      const detail =
        error instanceof Error && error.message ? error.message : String(error ?? 'unknown error');
      const message = sectionGenerateFailureMessage(section.label, detail);
      warnings.push(message);
      input.onProgress?.(message);
      await recordJobStepFailure(input.jobId, {
        key: `section:${section.id}`,
        label: `Building ${section.label}`,
        error: message,
      });
    }
  }

  if (
    sectionGenerationSeverity({ succeeded: paths.length, failed: failedSections }) === 'fallback'
  ) {
    throw new Error(warnings[0] || 'No sections could be generated');
  }

  try {
    const composition = await complete({
      stablePrefix,
      volatileUser: `${buildCompositionVolatilePrompt({
        mode: input.mode,
        tokens,
        sectionFiles: paths,
        designDirection: input.designDirection,
      })}\n\n${compositionHint(input.stack)}`,
      image: input.capture.desktopPng,
      projectId: input.projectId,
      userId: input.userId,
    });
    inputTokens += composition.inputTokens;
    files.push(composition.text);
  } catch (error) {
    const detail =
      error instanceof Error && error.message ? error.message : String(error ?? 'unknown error');
    const message = `The imported sections were generated, but the layout could not be composed (${detail}) — open the section files and try again.`;
    warnings.push(message);
    input.onProgress?.(message);
    await recordJobStepFailure(input.jobId, {
      key: 'compose',
      label: 'Composing layout',
      error: message,
    });
  }

  return { filesXml: joinFilesXml(files), inputTokens, warnings };
}

export async function generateImportFallback(input: {
  projectId: string;
  userId: string;
  stack: string;
  designDirection: string;
  mode: ImportMode;
  capture: PageCapture;
  assets: RehostedAsset[];
  /** ACTIVE workspace + project Brain memory, inside the cacheable prefix. */
  memoryBlock?: string | null;
  complete?: ImportCompleteXml;
}): Promise<GenerateSectionsResult> {
  const complete = input.complete ?? completeXml;
  const stablePrefix = buildImportStablePrefix(
    input.stack,
    input.designDirection,
    input.memoryBlock,
  );
  const result = await complete({
    stablePrefix,
    volatileUser: buildFallbackVolatilePrompt({
      mode: input.mode,
      tokens: formatDesignTokens(input.capture.tokens),
      firecrawlText: input.capture.firecrawlText,
      assets: input.assets,
      designDirection: input.designDirection,
      sourceUrl: input.capture.sourceUrl,
    }),
    image: input.capture.desktopPng,
    projectId: input.projectId,
    userId: input.userId,
  });
  return { filesXml: result.text, inputTokens: result.inputTokens };
}
