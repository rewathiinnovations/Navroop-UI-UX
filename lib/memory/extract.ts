import { generateText } from 'ai';
import { chatModelForProvider } from '@/lib/ai/client-for-entry';
import { getProviderForModel } from '@/lib/ai/provider-manager';
import { temperatureForModel } from '@/lib/ai/temperature';
import { RunUsage } from '@/lib/consumption/run-usage';
import { prisma } from '@/lib/db';
import { peekConversationState } from '@/lib/generation/conversation-state';
import { log } from '@/lib/logger';
import { recordHelperCallUsage } from '@/lib/usage-costs';
import { isDuplicateMemory, normalizeMemoryContent } from './normalize';
import { getMemoryExtractionEnabled } from './settings';
import {
  MEMORY_CATEGORIES,
  type MemoryCategory,
  type MemoryScope,
  type MemorySource,
  type MemoryStatus,
} from './types';

const MAX_EXTRACTED = 3;

/**
 * Room for three ~200-character proposals and the JSON around them, with slack.
 *
 * It was 400, which is roughly the answer's own size with nothing spare — and the request
 * goes to a thinking model, so the budget is shared with reasoning the client never reads.
 * A truncated or empty completion is billed in full and yields nothing to store; the other
 * two halves of that fix are `readExtractedMemories` below, which reports such a completion
 * as a failure rather than as an empty answer, and `deepseek-reasoning-sse.ts`, where a
 * non-streaming call like this one no longer asks for the highest reasoning tier.
 */
const EXTRACT_OUTPUT_TOKENS = 1200;

export type ExtractedProposal = {
  category: MemoryCategory;
  content: string;
  scope: 'PROJECT';
};

export type PendingInsert = {
  scope: MemoryScope;
  projectId: string;
  category: MemoryCategory;
  content: string;
  source: MemorySource;
  status: MemoryStatus;
};

/**
 * Two different outcomes that used to be one value.
 *
 * `ok: true, inserted: 0` means the run completed and had nothing to store — extraction is
 * off, the project said nothing durable, everything proposed was a duplicate. `ok: false`
 * means the run did not complete: the provider refused, the completion did not parse, the
 * insert failed. Both leave the generation alone; only the second one means money may have
 * been spent for nothing, and a caller (or a test) can now tell which it got.
 */
export type ExtractMemoriesResult =
  | { ok: true; inserted: number }
  | { ok: false; inserted: 0; error: string };

export type ExtractDeps = {
  isEnabled?: () => Promise<boolean>;
  listActiveContents?: (projectId: string) => Promise<string[]>;
  complete?: (userText: string) => Promise<string>;
  insertPending?: (rows: PendingInsert[]) => Promise<void>;
};

const EXTRACT_INSTRUCTION = `Identify DURABLE preferences or facts worth remembering across future sessions.
Ignore one-off task instructions (e.g. "add a footer", "fix the button").
Return a JSON array of up to 3 objects: { "category": "design"|"tech"|"content"|"context", "content": string, "scope": "PROJECT" }.
Extraction may only propose PROJECT scope, never WORKSPACE.
Each content must be one atomic instruction, at most 200 characters.
If nothing durable, return [].`;

function collectUserMessages(projectId: string, sourceMessage?: string | null) {
  // The project's own keyed conversation, never the old process-global — that slot was
  // overwritten by whichever request ran last, so extraction here could store another
  // user's prompt text as a MemoryEntry against this project.
  const fromState = peekConversationState(projectId)?.context.messages;
  const texts: string[] = [];
  for (const message of fromState ?? []) {
    if (message.role === 'user' && typeof message.content === 'string' && message.content.trim()) {
      texts.push(message.content.trim());
    }
  }
  if (sourceMessage?.trim()) texts.push(sourceMessage.trim());
  return [...new Set(texts)];
}

/**
 * Whether the completion could be read at all, and what it said if so.
 *
 * The distinction `parseExtractedMemories` cannot make: it answers `[]` both for a model
 * that said "nothing durable" and for a completion that never usably arrived. Only the
 * second has already been paid for, and it is the likelier of the two here — the output
 * budget above is shared with reasoning tokens the client never reads, so a truncated run
 * comes back as `''`.
 *
 * A well-formed array whose entries are all rejected below (an unknown category, a
 * 600-character "atomic instruction") is deliberately still `ok`: the model answered and
 * was read, and calling that a provider failure would file a fault of the prompt's on the
 * provider's side of the ledger.
 */
export type ParsedExtraction =
  | { ok: true; proposals: ExtractedProposal[] }
  | { ok: false; error: string };

export function readExtractedMemories(raw: string): ParsedExtraction {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, error: 'the completion was empty' };
  let parsed: unknown;
  try {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
    parsed = JSON.parse(fenced?.[1]?.trim() ?? trimmed);
  } catch {
    return { ok: false, error: 'the completion was not JSON' };
  }
  if (!Array.isArray(parsed)) return { ok: false, error: 'the completion was not a JSON array' };

  const out: ExtractedProposal[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    if (!MEMORY_CATEGORIES.includes(row.category as MemoryCategory)) continue;
    if (typeof row.content !== 'string') continue;
    const content = row.content.trim();
    if (!content || content.length > 500) continue;
    out.push({
      category: row.category as MemoryCategory,
      content,
      scope: 'PROJECT',
    });
    if (out.length >= MAX_EXTRACTED) break;
  }
  return { ok: true, proposals: out };
}

/** The proposals alone, for callers that have no use for the difference. */
export function parseExtractedMemories(raw: string): ExtractedProposal[] {
  const read = readExtractedMemories(raw);
  return read.ok ? read.proposals : [];
}

async function defaultComplete(input: {
  userText: string;
  userId: string | null;
  projectId: string;
}) {
  const { client, actualModel, thinking } = await getProviderForModel(null, input.userId);
  const prompt = `${EXTRACT_INSTRUCTION}\n\nUser messages:\n${input.userText}`;
  // This call is made once per successful generation and nothing paid for it. The chain
  // that produced it holds no Job row — it runs detached, after the build has settled — so
  // `recordJobUsage` cannot cover it; `recordHelperCallUsage` is the seam that prices it,
  // accrues it onto the spend ceiling and files the GenerationEvent row.
  const spent = new RunUsage();
  spent.willSend(prompt);
  try {
    const result = await generateText({
      model: chatModelForProvider(client, actualModel),
      // The same one decision every other provider call makes (F-041). This site kept a
      // hard-coded `temperature: 0` after the endpoint fix landed, and the two changes
      // cancelled out: every model on offer is a thinking model, `clientForEntry` injects
      // `thinking: { type: 'enabled' }` into the body it builds, and DeepSeek rejects a
      // request carrying both. `extractMemoriesAfterGeneration` catches everything, so the
      // refusal became `[memory] extraction failed` in the log and `inserted: 0` to the
      // caller — extraction stayed dead through the settle of every generation, for a
      // second reason, with nothing surfacing.
      //
      // `thinking` comes from the resolution that built this client, so the two halves of
      // the request cannot disagree. With thinking on this is `undefined` and
      // `JSON.stringify` drops the key rather than sending it.
      temperature: temperatureForModel(actualModel, { thinking }),
      maxOutputTokens: EXTRACT_OUTPUT_TOKENS,
      prompt,
    });
    spent.settle(result.usage, result.text);
    return result.text;
  } finally {
    // In `finally`, because a provider that took the prompt and then threw billed for it.
    // Reporting nothing on the failure path would make the most expensive outcome the
    // cheapest on the books — `RunUsage.claim` charges the open call from its prompt.
    const totals = spent.claim();
    if (totals) {
      await recordHelperCallUsage({
        kind: 'memory_extract',
        projectId: input.projectId,
        userId: input.userId,
        tokensIn: totals.tokensIn,
        tokensOut: totals.tokensOut,
        calls: totals.calls,
        estimatedCalls: totals.estimatedCalls,
        model: actualModel,
      });
    }
  }
}

async function defaultListActive(projectId: string) {
  const rows = await prisma.memoryEntry.findMany({
    where: {
      status: 'ACTIVE',
      OR: [
        { scope: 'WORKSPACE', projectId: null },
        { scope: 'PROJECT', projectId },
      ],
    },
    select: { content: true },
  });
  return rows.map((row) => row.content);
}

async function defaultInsert(rows: PendingInsert[]) {
  if (rows.length === 0) return;
  await prisma.memoryEntry.createMany({
    data: rows.map((row) => ({
      scope: row.scope,
      projectId: row.projectId,
      category: row.category,
      content: row.content,
      source: row.source,
      status: row.status,
    })),
  });
}

export async function extractMemoriesAfterGeneration(
  projectId: string,
  input: { sourceMessage?: string | null; userId?: string | null } = {},
  deps: ExtractDeps = {},
): Promise<ExtractMemoriesResult> {
  try {
    const enabled = deps.isEnabled ? await deps.isEnabled() : await getMemoryExtractionEnabled();
    if (!enabled) return { ok: true, inserted: 0 };

    const messages = collectUserMessages(projectId, input.sourceMessage);
    if (messages.length === 0) return { ok: true, inserted: 0 };

    const raw = deps.complete
      ? await deps.complete(messages.join('\n\n'))
      : await defaultComplete({
          userText: messages.join('\n\n'),
          userId: input.userId ?? null,
          projectId,
        });
    const read = readExtractedMemories(raw);
    // Thrown rather than returned, so the one `catch` below owns both the log line and the
    // `ok: false` shape: a completion that could not be read is the same kind of event as a
    // provider that refused, and the money is gone either way.
    if (!read.ok) throw new Error(`extraction completion unusable — ${read.error}`);
    const active = await (deps.listActiveContents ?? defaultListActive)(projectId);
    const unique = read.proposals.filter((row) => !isDuplicateMemory(row.content, active));
    const seen = new Set<string>();
    const rows: PendingInsert[] = [];
    for (const row of unique) {
      const key = normalizeMemoryContent(row.content);
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({
        scope: 'PROJECT',
        projectId,
        category: row.category,
        content: row.content,
        source: 'extracted',
        status: 'PENDING',
      });
    }

    if (rows.length > 0) {
      await (deps.insertPending ?? defaultInsert)(rows);
    }
    return { ok: true, inserted: rows.length };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Still non-throwing — this runs detached from a generation that has already succeeded,
    // and a failed extraction must not fail that. What changed is that it no longer answers
    // `{ ok: true, inserted: 0 }`, the same value a run that found nothing durable returns:
    // a completion that was paid for and came back unusable read as "the user said nothing
    // worth remembering", which is how a dead extraction survived two rounds of fixes. The
    // provider call is charged in `defaultComplete`'s `finally` whichever way this lands.
    log.warn('memory.extraction_failed', { projectId, error: message });
    return { ok: false, inserted: 0, error: message };
  }
}
