import { generateText } from 'ai';
import { getProviderForModel } from '@/lib/ai/provider-manager';
import { prisma } from '@/lib/db';
import { peekConversationState } from '@/lib/generation/conversation-state';
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

export function parseExtractedMemories(raw: string): ExtractedProposal[] {
  let parsed: unknown;
  try {
    const fenced = raw.trim().match(/```(?:json)?\s*([\s\S]*?)```/);
    parsed = JSON.parse(fenced?.[1]?.trim() ?? raw.trim());
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

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
  return out;
}

async function defaultComplete(userText: string, userId: string | null) {
  const { client, actualModel } = await getProviderForModel(null, userId);
  const result = await generateText({
    model: client(actualModel),
    temperature: 0,
    maxOutputTokens: 400,
    prompt: `${EXTRACT_INSTRUCTION}\n\nUser messages:\n${userText}`,
  });
  return result.text;
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
): Promise<{ ok: true; inserted: number }> {
  try {
    const enabled = deps.isEnabled ? await deps.isEnabled() : await getMemoryExtractionEnabled();
    if (!enabled) return { ok: true, inserted: 0 };

    const messages = collectUserMessages(projectId, input.sourceMessage);
    if (messages.length === 0) return { ok: true, inserted: 0 };

    const raw = deps.complete
      ? await deps.complete(messages.join('\n\n'))
      : await defaultComplete(messages.join('\n\n'), input.userId ?? null);
    const proposals = parseExtractedMemories(raw);
    const active = await (deps.listActiveContents ?? defaultListActive)(projectId);
    const unique = proposals.filter((row) => !isDuplicateMemory(row.content, active));
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
    console.warn('[memory] extraction failed', error);
    return { ok: true, inserted: 0 };
  }
}
