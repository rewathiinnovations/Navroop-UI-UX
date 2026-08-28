import type { ChatMessage } from '@/lib/generation/types';
import type { JobKind, JobStatus } from '@/lib/jobs/types';

/** sessionStorage key prefix — one thread per project, survives refresh in this tab. */
export const CHAT_STORAGE_PREFIX = 'navroop.chat.';

const MAX_PERSISTED_MESSAGES = 50;

export type ChatHistoryJob = {
  kind: JobKind | string;
  status: JobStatus | string;
  inputPrompt: string | null;
  filesWritten: number | null;
  errorMessage: string | null;
  createdAt: string;
  finishedAt: string | null;
};

export function chatStorageKey(projectId: string) {
  return `${CHAT_STORAGE_PREFIX}${projectId}`;
}

export function hasUserTurn(messages: readonly ChatMessage[]): boolean {
  return messages.some((message) => message.type === 'user' && message.content.trim());
}

export function shouldPersistChat(messages: readonly ChatMessage[]): boolean {
  return hasUserTurn(messages);
}

/** Drop the plan JSON Approve & Build writes onto `Job.inputPrompt`. */
export function displayJobPrompt(prompt: string | null | undefined): string {
  const raw = typeof prompt === 'string' ? prompt.trim() : '';
  if (!raw) return '';
  const cut = raw.indexOf('\n\nApproved plan:');
  return (cut === -1 ? raw : raw.slice(0, cut)).trim();
}

export function serializeChatMessages(messages: readonly ChatMessage[]): string {
  return JSON.stringify(
    messages.slice(-MAX_PERSISTED_MESSAGES).map((message) => ({
      ...message,
      timestamp:
        message.timestamp instanceof Date ? message.timestamp.toISOString() : message.timestamp,
    })),
  );
}

export function parseChatMessages(raw: string | null | undefined): ChatMessage[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return [];
      const row = entry as {
        content?: unknown;
        type?: unknown;
        timestamp?: unknown;
        metadata?: ChatMessage['metadata'];
      };
      if (typeof row.content !== 'string' || typeof row.type !== 'string') return [];
      const type = row.type as ChatMessage['type'];
      const at =
        typeof row.timestamp === 'string' || row.timestamp instanceof Date
          ? new Date(row.timestamp)
          : new Date(0);
      if (Number.isNaN(at.getTime())) return [];
      return [{ content: row.content, type, timestamp: at, metadata: row.metadata }];
    });
  } catch {
    return [];
  }
}

function storageOrNull(
  storage: Pick<Storage, 'getItem' | 'setItem'> | null | undefined,
): Pick<Storage, 'getItem' | 'setItem'> | null {
  if (storage) return storage;
  try {
    if (typeof sessionStorage === 'undefined') return null;
    return sessionStorage;
  } catch {
    return null;
  }
}

export function readPersistedChat(
  projectId: string,
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null,
): ChatMessage[] {
  if (!projectId) return [];
  const store = storageOrNull(storage);
  if (!store) return [];
  try {
    return parseChatMessages(store.getItem(chatStorageKey(projectId)));
  } catch {
    return [];
  }
}

export function writePersistedChat(
  projectId: string,
  messages: readonly ChatMessage[],
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null,
): void {
  if (!projectId || !shouldPersistChat(messages)) return;
  const store = storageOrNull(storage);
  if (!store) return;
  try {
    store.setItem(chatStorageKey(projectId), serializeChatMessages(messages));
  } catch {
    // Quota or private mode — job history still covers a later refresh.
  }
}

export function hydrateChatMessages(input: {
  live: readonly ChatMessage[];
  persisted: readonly ChatMessage[];
  fromJobs: readonly ChatMessage[];
}): ChatMessage[] {
  if (hasUserTurn(input.live)) return [...input.live];
  if (hasUserTurn(input.persisted)) return [...input.persisted];
  if (input.fromJobs.length > 0) return [...input.fromJobs];
  return [...input.live];
}

function jobTimestamp(value: string | null | undefined, fallback: string): Date {
  const parsed = value ? Date.parse(value) : Number.NaN;
  if (!Number.isNaN(parsed)) return new Date(parsed);
  const fallbackParsed = Date.parse(fallback);
  return Number.isNaN(fallbackParsed) ? new Date(0) : new Date(fallbackParsed);
}

function replyForJob(job: ChatHistoryJob): { type: ChatMessage['type']; content: string } | null {
  if (job.status === 'QUEUED' || job.status === 'RUNNING') return null;
  if (job.status === 'FAILED' || job.status === 'ABANDONED' || job.status === 'CANCELLED') {
    const detail = job.errorMessage?.trim();
    return { type: 'error', content: detail || 'The last build did not finish' };
  }
  if (job.kind === 'PLAN') {
    return { type: 'ai', content: 'Plan ready. Review and approve to apply these changes.' };
  }
  if (job.kind === 'IMPORT') {
    const url = displayJobPrompt(job.inputPrompt);
    return { type: 'system', content: url ? `Successfully recreated ${url}` : 'Import finished.' };
  }
  const count = job.filesWritten ?? 0;
  if (count === 0) {
    return { type: 'ai', content: 'Answered — no changes made' };
  }
  return {
    type: 'ai',
    content: `Successfully applied ${count} file${count === 1 ? '' : 's'}`,
  };
}

export function messagesFromChatJobs(jobs: readonly ChatHistoryJob[]): ChatMessage[] {
  const messages: ChatMessage[] = [];
  let lastUser = '';
  for (const job of jobs) {
    const prompt = displayJobPrompt(job.inputPrompt);
    const created = jobTimestamp(job.createdAt, '1970-01-01T00:00:00.000Z');
    if (prompt && prompt !== lastUser) {
      messages.push({ type: 'user', content: prompt, timestamp: created });
      lastUser = prompt;
    }
    const reply = replyForJob(job);
    if (reply) {
      messages.push({
        type: reply.type,
        content: reply.content,
        timestamp: jobTimestamp(job.finishedAt, job.createdAt),
      });
    }
  }
  return messages;
}

export async function fetchChatJobHistory(projectId: string): Promise<ChatHistoryJob[]> {
  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/job?history=1`);
  if (!response.ok) return [];
  const data = (await response.json()) as { jobs?: unknown };
  if (!Array.isArray(data.jobs)) return [];
  return data.jobs.flatMap((row) => {
    if (!row || typeof row !== 'object') return [];
    const job = row as Partial<ChatHistoryJob>;
    if (typeof job.createdAt !== 'string') return [];
    return [
      {
        kind: typeof job.kind === 'string' ? job.kind : 'BUILD',
        status: typeof job.status === 'string' ? job.status : 'SUCCEEDED',
        inputPrompt: typeof job.inputPrompt === 'string' ? job.inputPrompt : null,
        filesWritten: typeof job.filesWritten === 'number' ? job.filesWritten : 0,
        errorMessage: typeof job.errorMessage === 'string' ? job.errorMessage : null,
        createdAt: job.createdAt,
        finishedAt: typeof job.finishedAt === 'string' ? job.finishedAt : null,
      },
    ];
  });
}

export async function loadHydratedChat(
  projectId: string,
  live: readonly ChatMessage[],
  fetchJobs: (id: string) => Promise<ChatHistoryJob[]> = fetchChatJobHistory,
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null,
): Promise<ChatMessage[]> {
  const persisted = readPersistedChat(projectId, storage);
  if (hasUserTurn(live) || hasUserTurn(persisted)) {
    return hydrateChatMessages({ live, persisted, fromJobs: [] });
  }
  return hydrateChatMessages({
    live,
    persisted,
    fromJobs: messagesFromChatJobs(await fetchJobs(projectId)),
  });
}
