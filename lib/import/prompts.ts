import type { ImportMode } from './mode.ts';
import type { ImportSection, RehostedAsset } from './types.ts';

export function buildSectionVolatilePrompt(input: {
  mode: ImportMode;
  tokens: string;
  section: ImportSection;
  firecrawlText: string;
  assets: RehostedAsset[];
  designDirection: string;
}) {
  const assets =
    input.assets.length > 0
      ? input.assets
          .map((asset) => `- ${asset.url} | ${asset.altText} | ${asset.width}x${asset.height}`)
          .join('\n')
      : '(none for this section)';

  const modeBlock =
    input.mode === 'replicate'
      ? `MODE: replicate — faithful rebuild. Match source typography, color, radius, and spacing from the extracted tokens. Recreate this section as it appears.`
      : `MODE: reimagine — keep structure, content, and hierarchy only. Apply the project's "${input.designDirection}" design direction and look deliberately different from the source screenshot.`;

  return `${modeBlock}

${input.tokens}

SECTION
id: ${input.section.id}
label: ${input.section.label}
purpose: ${input.section.purpose}
y-range: ${input.section.approximateYRange[0]}–${input.section.approximateYRange[1]}
summary: ${input.section.contentSummary}

PAGE TEXT (complementary, this section only when possible):
${input.firecrawlText.slice(0, 4000)}

REHOSTED ASSETS (use these URLs only — never hotlink the source site):
${assets}

RULES
- Output one complete component file for THIS section only.
- Use rehosted asset URLs only. Do not invent or reuse original page image URLs.
- XML: <file path="...">full contents</file>`;
}

export function buildFallbackVolatilePrompt(input: {
  mode: ImportMode;
  tokens: string;
  firecrawlText: string;
  assets: RehostedAsset[];
  designDirection: string;
  sourceUrl: string;
}) {
  const assets =
    input.assets.length > 0
      ? input.assets
          .map((asset) => `- ${asset.url} | ${asset.altText} | ${asset.width}x${asset.height}`)
          .join('\n')
      : '(none)';
  const modeBlock =
    input.mode === 'replicate'
      ? `MODE: replicate — faithful rebuild of ${input.sourceUrl}. Match source tokens.`
      : `MODE: reimagine — rebuild ${input.sourceUrl} with the project's "${input.designDirection}" design direction. Keep structure/content/hierarchy; look deliberately different.`;

  return `${modeBlock}

${input.tokens}

PAGE TEXT:
${input.firecrawlText.slice(0, 8000)}

REHOSTED ASSETS (use these URLs only — never hotlink the source site):
${assets}

RULES
- Create a complete working site for the project's stack.
- Use rehosted asset URLs only.
- XML: <file path="...">full contents</file>`;
}

export function buildCompositionVolatilePrompt(input: {
  mode: ImportMode;
  tokens: string;
  sectionFiles: { path: string; label: string }[];
  designDirection: string;
}) {
  const files = input.sectionFiles.map((file) => `- ${file.path} (${file.label})`).join('\n');
  const modeBlock =
    input.mode === 'replicate'
      ? 'MODE: replicate — compose a faithful full-page layout that matches source tokens.'
      : `MODE: reimagine — compose layout using the "${input.designDirection}" design direction; look deliberately different.`;

  return `${modeBlock}

${input.tokens}

SECTION COMPONENTS (already generated — import them, do not rewrite):
${files}

RULES
- Output layout + nav/footer reconcile files only.
- Import the section components above. Do not duplicate their markup.
- Use rehosted asset URLs only if images appear in chrome.
- XML: <file path="...">full contents</file>`;
}
