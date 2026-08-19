/**
 * Plans where to look in the project for the code a follow-up prompt is about.
 *
 * The model returns search terms and patterns, not file paths — guessing files
 * from a manifest listing is far less reliable than searching for the exact
 * button text the user quoted.
 *
 * Extracted from POST /api/analyze-edit-intent so the generation stream can
 * call it directly instead of over HTTP. The route is a thin wrapper.
 */
import { generateObject } from 'ai';
import { z } from 'zod';
import { getProviderForModel } from '@/lib/ai/provider-manager';
import { ProviderNotConfiguredError } from '@/lib/ai/providers';

const searchPlanSchema = z.object({
  editType: z
    .enum([
      'UPDATE_COMPONENT',
      'ADD_FEATURE',
      'FIX_ISSUE',
      'UPDATE_STYLE',
      'REFACTOR',
      'ADD_DEPENDENCY',
      'REMOVE_ELEMENT',
    ])
    .describe('The type of edit being requested'),

  reasoning: z.string().describe('Explanation of the search strategy'),

  searchTerms: z
    .array(z.string())
    .describe(
      'Specific text to search for (case-insensitive). Be VERY specific - exact button text, class names, etc.',
    ),

  regexPatterns: z
    .array(z.string())
    .optional()
    .describe(
      'Regex patterns for finding code structures (e.g., "className=[\\"\\\'].*header.*[\\"\\\']")',
    ),

  fileTypesToSearch: z
    .array(z.string())
    .default(['.jsx', '.tsx', '.js', '.ts'])
    .describe('File extensions to search'),

  expectedMatches: z
    .number()
    .min(1)
    .max(10)
    .default(1)
    .describe('Expected number of matches (helps validate search worked)'),

  fallbackSearch: z
    .object({
      terms: z.array(z.string()),
      patterns: z.array(z.string()).optional(),
    })
    .optional()
    .describe('Backup search if primary fails'),
});

export type SearchPlan = z.infer<typeof searchPlanSchema>;

export type AnalyzeEditIntentInput = {
  prompt: unknown;
  manifest: unknown;
  model?: string;
};

export type AnalyzeEditIntentResult =
  { ok: true; searchPlan: SearchPlan } | { ok: false; status: number; error: string };

type ManifestLike = { files?: Record<string, unknown> };

async function selectModel(model: string) {
  const { client, actualModel } = await getProviderForModel(model);
  return client(actualModel);
}

export async function analyzeEditIntent(
  input: AnalyzeEditIntentInput,
): Promise<AnalyzeEditIntentResult> {
  const { prompt, manifest } = input;
  const model = input.model || 'openai/gpt-oss-20b';

  console.log('[analyze-edit-intent] Request received');
  console.log('[analyze-edit-intent] Prompt:', prompt);
  console.log('[analyze-edit-intent] Model:', model);

  const manifestFiles = (manifest as ManifestLike | null | undefined)?.files;
  console.log(
    '[analyze-edit-intent] Manifest files count:',
    manifestFiles ? Object.keys(manifestFiles).length : 0,
  );

  if (!prompt || !manifest) {
    return { ok: false, status: 400, error: 'prompt and manifest are required' };
  }

  const validFiles = Object.entries(manifestFiles ?? {}).filter(([path]) => {
    // Drop paths that are not files, and the numeric artefacts the parser emits.
    return path.includes('.') && !path.match(/\/\d+$/);
  });

  const fileSummary = validFiles
    .map(([path, info]) => {
      const entry = info as { componentInfo?: { name?: string; childComponents?: string[] } };
      const componentName = entry.componentInfo?.name || path.split('/').pop();
      const childComponents = entry.componentInfo?.childComponents?.join(', ') || 'none';
      return `- ${path} (${componentName}, renders: ${childComponents})`;
    })
    .join('\n');

  console.log('[analyze-edit-intent] Valid files found:', validFiles.length);

  if (validFiles.length === 0) {
    console.error('[analyze-edit-intent] No valid files found in manifest');
    return { ok: false, status: 400, error: 'No valid files found in manifest' };
  }

  console.log('[analyze-edit-intent] Analyzing prompt:', prompt);
  console.log(
    '[analyze-edit-intent] File summary preview:',
    fileSummary.split('\n').slice(0, 5).join('\n'),
  );
  console.log('[analyze-edit-intent] Using AI model:', model);

  try {
    const result = await generateObject({
      model: await selectModel(model),
      schema: searchPlanSchema,
      messages: [
        {
          role: 'system',
          content: `You are an expert at planning code searches. Your job is to create a search strategy to find the exact code that needs to be edited.

DO NOT GUESS which files to edit. Instead, provide specific search terms that will locate the code.

SEARCH STRATEGY RULES:
1. For text changes (e.g., "change 'Start Deploying' to 'Go Now'"):
   - Search for the EXACT text: "Start Deploying"
   
2. For style changes (e.g., "make header black"):
   - Search for component names: "Header", "<header"
   - Search for class names: "header", "navbar"
   - Search for className attributes containing relevant words
   
3. For removing elements (e.g., "remove the deploy button"):
   - Search for the button text or aria-label
   - Search for relevant IDs or data-testids
   
4. For navigation/header issues:
   - Search for: "navigation", "nav", "Header", "navbar"
   - Look for Link components or href attributes
   
5. Be SPECIFIC:
   - Use exact capitalization for user-visible text
   - Include multiple search terms for redundancy
   - Add regex patterns for structural searches

Current project structure for context:
${fileSummary}`,
        },
        {
          role: 'user',
          content: `User request: "${prompt}"

Create a search plan to find the exact code that needs to be modified. Include specific search terms and patterns.`,
        },
      ],
    });

    console.log('[analyze-edit-intent] Search plan created:', {
      editType: result.object.editType,
      searchTerms: result.object.searchTerms,
      patterns: result.object.regexPatterns?.length || 0,
      reasoning: result.object.reasoning,
    });

    return { ok: true, searchPlan: result.object };
  } catch (error) {
    console.error('[analyze-edit-intent] Error:', error);
    if (error instanceof ProviderNotConfiguredError) {
      // The step failure this becomes ("Plan the edit") is the first place an
      // operator with a DB-only key used to see anything at all, and a 500
      // reading like a provider outage sent them to the wrong page. 503 plus
      // the configuration sentence names what to fix.
      return { ok: false, status: 503, error: error.message };
    }
    return { ok: false, status: 500, error: (error as Error).message };
  }
}
