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
import { log, logError } from '@/lib/logger';
import { filterSearchPatterns } from './search-pattern';

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
  /** Acting user — credential resolution must match the generation call (F-073). */
  userId: string | null;
};

export type AnalyzeEditIntentResult =
  { ok: true; searchPlan: SearchPlan } | { ok: false; status: number; error: string };

type ManifestLike = { files?: Record<string, unknown> };

async function selectModel(model: string, userId: string | null) {
  const { client, actualModel } = await getProviderForModel(model, userId);
  return client(actualModel);
}

export async function analyzeEditIntent(
  input: AnalyzeEditIntentInput,
): Promise<AnalyzeEditIntentResult> {
  const { prompt, manifest } = input;
  const model = input.model || 'openai/gpt-oss-20b';

  // The prompt and the file summary are user content. They used to be written to
  // stdout in full on every call, which put project source and whatever someone
  // typed into a second store with a different retention policy than the
  // database (F-039). Shapes and counts only.
  const manifestFiles = (manifest as ManifestLike | null | undefined)?.files;

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

  if (validFiles.length === 0) {
    log.warn('generation.edit_intent_empty_manifest', {
      manifestFiles: manifestFiles ? Object.keys(manifestFiles).length : 0,
    });
    return { ok: false, status: 400, error: 'No valid files found in manifest' };
  }

  log.info('generation.edit_intent_planning', { model, files: validFiles.length });

  try {
    const result = await generateObject({
      model: await selectModel(model, input.userId),
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

    // Model-written regexes are bounded before they leave this function. Nothing
    // compiles them today — the executor that ran them per line of every file was
    // deleted — but the plan is returned over HTTP, and an unbounded
    // catastrophically backtracking pattern blocks the whole event loop the moment
    // anything does (F-752). Refusals are named, never dropped in silence.
    const primary = filterSearchPatterns(result.object.regexPatterns);
    const fallback = filterSearchPatterns(result.object.fallbackSearch?.patterns);
    const refused = [...primary.refused, ...fallback.refused];
    if (refused.length > 0) {
      log.warn('generation.edit_intent_patterns_refused', {
        count: refused.length,
        refused: refused.slice(0, 5),
      });
    }

    const searchPlan: SearchPlan = {
      ...result.object,
      regexPatterns: primary.safe,
      fallbackSearch: result.object.fallbackSearch
        ? { ...result.object.fallbackSearch, patterns: fallback.safe }
        : undefined,
    };

    log.info('generation.edit_intent_plan', {
      editType: searchPlan.editType,
      terms: searchPlan.searchTerms.length,
      patterns: primary.safe.length,
      refusedPatterns: refused.length,
    });

    return { ok: true, searchPlan };
  } catch (error) {
    logError('generation.edit_intent_failed', error);
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
