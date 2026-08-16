'use client';

import { createContext, useContext, useEffect, useMemo, useSyncExternalStore } from 'react';
import type { CodeApplicationState } from '@/components/CodeApplicationProgress';
import {
  addGenerationMessage,
  attachToProject as attachToProjectRuntime,
  clearGeneration,
  executeGenerationJob,
  getGenerationState,
  markGenerationError,
  markGenerationReady,
  setCodeApplicationState,
  setGenerationMessages,
  setGenerationProgressState,
  setGenerationProjectId,
  setGenerationSandboxData,
  startApply as startApplyRuntime,
  startGeneration as startGenerationRuntime,
  subscribeGeneration,
  subscribeGenerationJobs,
} from '@/lib/generation/generation-runtime';
import {
  isActiveGenerationStatus,
  type ApplyResult,
  type ChatMessage,
  type GenerateResult,
  type GenerationProgressState,
  type GenerationState,
  type SandboxData,
  type StartApplyInput,
  type StartGenerationInput,
} from '@/lib/generation/types';

type GenerationContextValue = GenerationState & {
  isJobActive: boolean;
  startGeneration: (input: StartGenerationInput) => Promise<GenerateResult>;
  startApply: (input: StartApplyInput) => Promise<ApplyResult>;
  attachToProject: (projectId: string | null) => GenerationState;
  clear: () => void;
  setProjectId: (projectId: string | null) => void;
  setSandboxData: (sandboxData: SandboxData | null) => void;
  setChatMessages: (messages: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[])) => void;
  addChatMessage: (content: string, type: ChatMessage['type'], metadata?: ChatMessage['metadata']) => void;
  setGenerationProgress: (
    progress: GenerationProgressState | ((prev: GenerationProgressState) => GenerationProgressState)
  ) => void;
  setCodeApplicationState: (
    next: CodeApplicationState | ((prev: CodeApplicationState) => CodeApplicationState)
  ) => void;
  markError: (message: string) => void;
  markReady: () => void;
};

const GenerationContext = createContext<GenerationContextValue | null>(null);

export function GenerationProvider({ children }: { children: React.ReactNode }) {
  const state = useSyncExternalStore(subscribeGeneration, getGenerationState, getGenerationState);

  useEffect(() => {
    return subscribeGenerationJobs(executeGenerationJob);
  }, []);

  const value = useMemo<GenerationContextValue>(() => ({
    ...state,
    isJobActive: isActiveGenerationStatus(state.status),
    startGeneration: startGenerationRuntime,
    startApply: startApplyRuntime,
    attachToProject: attachToProjectRuntime,
    clear: clearGeneration,
    setProjectId: setGenerationProjectId,
    setSandboxData: setGenerationSandboxData,
    setChatMessages: setGenerationMessages,
    addChatMessage: addGenerationMessage,
    setGenerationProgress: setGenerationProgressState,
    setCodeApplicationState,
    markError: markGenerationError,
    markReady: markGenerationReady,
  }), [state]);

  return (
    <GenerationContext.Provider value={value}>
      {children}
    </GenerationContext.Provider>
  );
}

export function useGeneration() {
  const context = useContext(GenerationContext);
  if (!context) {
    throw new Error('useGeneration must be used within GenerationProvider');
  }
  return context;
}
