import type { ParseFilesErrorCode } from './parse-files';
import type { CodeApplicationState } from '@/components/CodeApplicationProgress';

export type GenerationStatus = 'idle' | 'generating' | 'applying' | 'ready' | 'error';

export interface SandboxData {
  sandboxId: string;
  url: string;
  [key: string]: unknown;
}

export interface BrandingData {
  colorScheme?: string;
  colors?: {
    primary?: string;
    accent?: string;
    background?: string;
    textPrimary?: string;
  };
  typography?: {
    fontFamilies?: {
      primary?: string;
      heading?: string;
    };
    fontSizes?: {
      h1?: string;
      h2?: string;
      body?: string;
    };
  };
  spacing?: {
    baseUnit?: number | string;
    borderRadius?: string;
  };
  components?: {
    buttonPrimary?: {
      background?: string;
      textColor?: string;
      borderRadius?: string;
      shadow?: string;
    };
    buttonSecondary?: {
      background?: string;
      textColor?: string;
      borderRadius?: string;
      shadow?: string;
    };
  };
  personality?: {
    tone?: string;
    energy?: string;
    targetAudience?: string;
  };
}

export interface ChatMessage {
  content: string;
  type: 'user' | 'ai' | 'system' | 'file-update' | 'command' | 'error';
  timestamp: Date;
  metadata?: {
    scrapedUrl?: string;
    scrapedContent?: unknown;
    generatedCode?: string;
    appliedFiles?: string[];
    commandType?: 'input' | 'output' | 'error' | 'success';
    brandingData?: BrandingData;
    sourceUrl?: string;
    source?: 'chat' | 'visual-edit' | 'comment';
    skillNames?: string[];
    creditDenial?: {
      reason: string;
      used: number;
      limit: number;
      message: string;
    };
  };
}

/**
 * A `{path=…}` block whose path could not be used, and why. Surfaced in state
 * rather than only logged because the audit of this area found several silent
 * drops: the file simply never appeared and nothing said why.
 */
export type DroppedGenerationPath = {
  /** The path exactly as the model wrote it, so the notice matches the reply. */
  path: string;
  reason: ParseFilesErrorCode;
};

export interface GenerationFile {
  path: string;
  content: string;
  type: string;
  completed: boolean;
  edited?: boolean;
}

export interface GenerationProgressState {
  isGenerating: boolean;
  status: string;
  components: Array<{ name: string; path: string; completed: boolean }>;
  currentComponent: number;
  streamedCode: string;
  isStreaming: boolean;
  isThinking: boolean;
  thinkingText?: string;
  thinkingDuration?: number;
  /**
   * Legacy mirror of the block still streaming. `files` now carries the same
   * block as its trailing `completed: false` entry; prefer that.
   */
  currentFile?: { path: string; content: string; type: string };
  /**
   * Files seen in the stream so far. At most one entry has `completed: false`
   * and it is the last element — see `applyStreamedCode`.
   */
  files: GenerationFile[];
  /** Paths dropped by `sanitizeGenerationPath`, first-seen order, deduped. */
  droppedPaths: DroppedGenerationPath[];
  /**
   * Scan cursor into `streamedCode`: the offset every closed `{path=…}` fence
   * sits before, so the next chunk is parsed from here rather than from zero.
   * Reset to 0 wherever `streamedCode` is reset, and clamped to the buffer's
   * length by `applyStreamedCode` so a stale value can never skip a new reply.
   */
  lastProcessedPosition: number;
  isEdit?: boolean;
}

export interface GenerationState {
  projectId: string | null;
  status: GenerationStatus;
  streamedText: string;
  messages: ChatMessage[];
  sandboxData: SandboxData | null;
  lastError: string | null;
  startedAt: number | null;
  generationProgress: GenerationProgressState;
  codeApplicationState: CodeApplicationState;
  lastGeneratedCode: string | null;
}

export type StartGenerationInput = {
  prompt: string;
  model: string;
  styleHint?: string | null;
  context?: Record<string, unknown>;
  isEdit?: boolean;
  projectId?: string | null;
  sandboxData?: SandboxData | null;
  idempotencyKey?: string | null;
  /**
   * Model fix attempts already spent on this build, echoed back from the
   * previous reply's `buildFix`. The server's attempt cap reads it; omitting it
   * made every retry look like the first.
   */
  buildFixAttempt?: number;
  /**
   * Signature of the failure this generation is repairing, so the server can
   * stop a loop that is re-emitting the same broken file.
   */
  buildFixSignature?: string | null;
};

export type StartApplyInput = {
  code: string;
  isEdit?: boolean;
  sandboxId?: string | null;
};

/** Returned on the generate `complete` frame when the build needs another pass. */
export type BuildFixRequest = {
  instruction: string;
  attempt: number;
  signature: string | null;
};

export type GenerateResult = {
  generatedCode: string;
  explanation: string;
  alreadyRunning?: boolean;
  skillNames?: string[];
  /**
   * The repair pass the server decided is warranted, or null. The server owns
   * the whole policy (attempt cap, repeated-failure guard, admin toggle); the
   * client only runs what it is handed and carries the counter back.
   */
  buildFix?: BuildFixRequest | null;
  /**
   * The SSE stream ended with no terminal frame — a transport drop, not a failure. The
   * build may still be finishing server-side, so the client neither PATCHed a status nor
   * applied anything; the job poll takes over (F-036).
   */
  streamDropped?: boolean;
};

export type ApplyResult = {
  finalData: Record<string, unknown> | null;
  alreadyRunning?: boolean;
};

export const EMPTY_GENERATION_PROGRESS: GenerationProgressState = {
  isGenerating: false,
  status: '',
  components: [],
  currentComponent: 0,
  streamedCode: '',
  isStreaming: false,
  isThinking: false,
  files: [],
  droppedPaths: [],
  lastProcessedPosition: 0,
};

export const INITIAL_GENERATION_STATE: GenerationState = {
  projectId: null,
  status: 'idle',
  streamedText: '',
  messages: [],
  sandboxData: null,
  lastError: null,
  startedAt: null,
  generationProgress: EMPTY_GENERATION_PROGRESS,
  codeApplicationState: { stage: null },
  lastGeneratedCode: null,
};

export function isActiveGenerationStatus(status: GenerationStatus) {
  return status === 'generating' || status === 'applying';
}
