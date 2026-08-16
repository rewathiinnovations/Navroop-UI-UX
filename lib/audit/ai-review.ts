import { generateText } from 'ai';
import { appConfig } from '@/config/app.config';
import { getProviderForModel } from '@/lib/ai/provider-manager';
import { buildCachedMessages } from '@/lib/generation/prompt-cache';
import { estimateTokens } from '@/lib/generation/token-estimate';
import { buildStablePromptPrefix } from '@/lib/stack-prompts';
import type { FileSnapshotEntry } from '@/lib/checkpoints/snapshot';
import { finding } from './findings';
import { toolFailedFinding } from './static/tool-fail';
import type { CodeFinding } from './types';

const FILE_CAP = 10;
const TOKEN_BUDGET = 40_000;
const SOURCE_RE = /\.(tsx?|jsx?|vue|svelte|astro)$/i;

export function shouldSkipAiReview(staticFindings: CodeFinding[]): boolean {
  const count = staticFindings.filter((row) => row.status !== 'pass' && !row.ignored).length;
  return count >= 20;
}

export function selectFilesForAiReview(
  files: FileSnapshotEntry[],
  staticFindings: CodeFinding[],
): FileSnapshotEntry[] {
  const covered = new Set(
    staticFindings
      .filter((row) => (row.category === 'typescript' || row.category === 'lint') && row.filePath)
      .map((row) => row.filePath),
  );
  const candidates = files
    .filter((file) => SOURCE_RE.test(file.path) && !covered.has(file.path))
    .sort((left, right) => right.content.length - left.content.length)
    .slice(0, FILE_CAP);

  const picked: FileSnapshotEntry[] = [];
  let tokens = 0;
  for (const file of candidates) {
    const next = estimateTokens(file.content);
    if (picked.length > 0 && tokens + next > TOKEN_BUDGET) break;
    picked.push(file);
    tokens += next;
  }
  return picked;
}

type AiReviewJson = {
  findings?: Array<{
    title?: string;
    detail?: string;
    filePath?: string;
    line?: number;
    status?: string;
  }>;
};

export function parseAiReviewJson(raw: string): CodeFinding[] {
  let parsed: AiReviewJson;
  try {
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    const candidate = fenced?.[1]?.trim() ?? raw.trim();
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    parsed = JSON.parse(start >= 0 && end > start ? candidate.slice(start, end + 1) : candidate) as AiReviewJson;
  } catch {
    return [];
  }
  return (parsed.findings || []).flatMap((row, index) => {
    if (!row?.title) return [];
    const status = row.status === 'high' || row.status === 'medium' || row.status === 'low' ? row.status : 'medium';
    return [
      finding({
        id: `ai-review:${row.filePath || 'file'}:${index}:${row.title}`,
        category: 'ai-review',
        status,
        title: row.title,
        detail: typeof row.detail === 'string' ? row.detail : '',
        filePath: row.filePath,
        line: typeof row.line === 'number' ? row.line : undefined,
      }),
    ];
  });
}

export async function runAiReview(input: {
  stack: string;
  directionId?: string | null;
  files: FileSnapshotEntry[];
  staticFindings: CodeFinding[];
}): Promise<CodeFinding[]> {
  if (shouldSkipAiReview(input.staticFindings)) {
    console.info('[audit] skipping AI review because static findings >= 20', {
      count: input.staticFindings.filter((row) => row.status !== 'pass' && !row.ignored).length,
    });
    return [];
  }
  const files = selectFilesForAiReview(input.files, input.staticFindings);
  if (files.length === 0) return [];
  try {
    const { client, actualModel } = getProviderForModel(appConfig.ai.defaultModel);
    const stablePrefix = buildStablePromptPrefix(input.stack, input.directionId);
    const listing = files
      .map((file) => `--- ${file.path} ---\n${file.content}`)
      .join('\n\n');
    const volatile = [
      'Review only what static analysis cannot fully evaluate: composition, unnecessary re-renders, unbounded state growth, missing async/loading/error states, and hardcoded design tokens.',
      'Return JSON only: { "findings": [{ "title", "detail", "filePath", "line?", "status": "high"|"medium"|"low" }] }.',
      'Do not repeat TypeScript, lint, dependency, or bundle issues.',
      listing,
    ].join('\n\n');
    const enableAnthropicCache = appConfig.ai.defaultModel.startsWith('anthropic/');
    const messages = buildCachedMessages({
      stablePrefix,
      volatileUser: volatile,
      enableAnthropicCache,
    });
    const result = await generateText({
      model: client(actualModel),
      messages,
    });
    return parseAiReviewJson(result.text);
  } catch (error) {
    return [toolFailedFinding('ai-review', error)];
  }
}
