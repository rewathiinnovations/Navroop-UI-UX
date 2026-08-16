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
  };
}

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
  currentFile?: { path: string; content: string; type: string };
  files: GenerationFile[];
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
};

export type StartApplyInput = {
  code: string;
  isEdit?: boolean;
  packages?: string[];
  sandboxId?: string | null;
};

export type GenerateResult = {
  generatedCode: string;
  explanation: string;
  packagesToInstall: string[];
  alreadyRunning?: boolean;
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
