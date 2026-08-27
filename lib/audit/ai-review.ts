import { generateText } from 'ai';
import { chatModelForProvider } from '@/lib/ai/client-for-entry';
import { getProviderForModel } from '@/lib/ai/provider-manager';
import { RunUsage, type RunUsageTotals } from '@/lib/consumption/run-usage';
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
    parsed = JSON.parse(
      start >= 0 && end > start ? candidate.slice(start, end + 1) : candidate,
    ) as AiReviewJson;
  } catch {
    return [];
  }
  return (parsed.findings || []).flatMap((row, index) => {
    if (!row?.title) return [];
    const status =
      row.status === 'high' || row.status === 'medium' || row.status === 'low'
        ? row.status
        : 'medium';
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

/**
 * What one AI review actually spent, so a call the user was not charged for is still
 * a call the operator can see.
 *
 * `provider` is null on purpose: `getProviderForModel` hands back a client and a model
 * id and never names the entry it chose, and inventing a vendor here would put a
 * guess into `Job.provider` and into the rate lookup. `resolveTokenRate` reads
 * `${provider} ${model}` as one string and matches on the model alone, so a null
 * provider still prices a DeepSeek model at its own tier.
 */
export type AiReviewUsage = RunUsageTotals & {
  provider: string | null;
  model: string | null;
};

export type AiReviewResult = {
  findings: CodeFinding[];
  /** Null when no provider call went out at all — skipped, no files, or no client. */
  usage: AiReviewUsage | null;
};

/**
 * The audit's one provider call.
 *
 * It returns its usage rather than swallowing it because this is real money leaving
 * the operator's account: up to {@link TOKEN_BUDGET} input tokens of the user's source
 * per run. Nothing here charged the user and nothing here recorded the spend either,
 * so the call was invisible to `/admin/usage`, to `Workspace.spendUsd` and to the
 * 100%-of-ceiling auto-pause — the operator's provider invoice and the product's own
 * accounting could differ by the whole cost of every audit ever run, with no row
 * anywhere explaining the gap. "Free to the user" is not "invisible to the operator";
 * the caller records what comes back here through `recordJobUsage`.
 *
 * `RunUsage` rather than a bare read of `result.usage`, for the reason it exists: a
 * provider that accepted the prompt and *then* failed still billed for the prompt, and
 * a review killed by a 429 halfway through is the most expensive outcome this function
 * has. `claim()` closes the open call and charges it from the prompt text.
 */
export async function runAiReview(input: {
  stack: string;
  directionId?: string | null;
  files: FileSnapshotEntry[];
  staticFindings: CodeFinding[];
  /** Acting user — credential resolution must match the generation call (F-073). */
  userId: string | null;
}): Promise<AiReviewResult> {
  if (shouldSkipAiReview(input.staticFindings)) {
    console.info('[audit] skipping AI review because static findings >= 20', {
      count: input.staticFindings.filter((row) => row.status !== 'pass' && !row.ignored).length,
    });
    return { findings: [], usage: null };
  }
  const files = selectFilesForAiReview(input.files, input.staticFindings);
  if (files.length === 0) return { findings: [], usage: null };
  const spent = new RunUsage();
  let model: string | null = null;
  try {
    const { client, actualModel } = await getProviderForModel(null, input.userId);
    model = actualModel;
    const stablePrefix = buildStablePromptPrefix(input.stack, input.directionId);
    const listing = files.map((file) => `--- ${file.path} ---\n${file.content}`).join('\n\n');
    const volatile = [
      'Review only what static analysis cannot fully evaluate: composition, unnecessary re-renders, unbounded state growth, missing async/loading/error states, and hardcoded design tokens.',
      'Return JSON only: { "findings": [{ "title", "detail", "filePath", "line?", "status": "high"|"medium"|"low" }] }.',
      'Do not repeat TypeScript, lint, dependency, or bundle issues.',
      listing,
    ].join('\n\n');
    const messages = buildCachedMessages({ stablePrefix, volatileUser: volatile });
    spent.willSend(`${stablePrefix}\n\n${volatile}`);
    const result = await generateText({
      model: chatModelForProvider(client, actualModel),
      messages,
    });
    spent.settle(result.usage, result.text);
    return { findings: parseAiReviewJson(result.text), usage: claimedUsage(spent, model) };
  } catch (error) {
    return { findings: [toolFailedFinding('ai-review', error)], usage: claimedUsage(spent, model) };
  }
}

/** Totals worth recording, or null when nothing was ever sent to a provider. */
function claimedUsage(spent: RunUsage, model: string | null): AiReviewUsage | null {
  const totals = spent.claim();
  if (!totals || totals.calls === 0) return null;
  return { ...totals, provider: null, model };
}

/**
 * The row that says the AI review is waiting for the user, not that it failed.
 *
 * This is the check the automatic post-build scan most obviously must not run: one
 * `generateText` carrying up to {@link TOKEN_BUDGET} input tokens of the user's source,
 * on every settled build. So it stays behind the Scan button, and the panel says so
 * rather than showing the static half as though it were the whole audit. The id is
 * deliberately not `toolFailedId('ai-review')` — that one means the call went out and
 * came back wrong.
 */
export function aiReviewNeedsScanFinding(): CodeFinding {
  return finding({
    id: 'tool:ai-review:needs-scan',
    category: 'tool',
    status: 'low',
    title: 'AI code review not run yet',
    detail:
      'The automatic check after a build runs only the free, fast checks. The AI review sends your code to the model, so it runs when you press Scan.',
    fixable: false,
  });
}
