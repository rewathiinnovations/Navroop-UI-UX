import type { CodeApplicationState } from '@/components/CodeApplicationProgress';
import {
  EMPTY_GENERATION_PROGRESS,
  INITIAL_GENERATION_STATE,
  isActiveGenerationStatus,
  type ApplyResult,
  type ChatMessage,
  type GenerateResult,
  type GenerationFile,
  type GenerationProgressState,
  type GenerationState,
  type GenerationStatus,
  type SandboxData,
  type StartApplyInput,
  type StartGenerationInput,
} from './types';
import { emitLockConflict, parseLockConflict } from '@/lib/projects/lock-client';

type Listener = () => void;
type JobHandler = (job: RuntimeJob) => Promise<void>;

type RuntimeJob =
  | {
      id: string;
      type: 'generate';
      input: StartGenerationInput;
      resolve: (value: GenerateResult) => void;
      reject: (error: unknown) => void;
    }
  | {
      id: string;
      type: 'apply';
      input: StartApplyInput;
      resolve: (value: ApplyResult) => void;
      reject: (error: unknown) => void;
    };

let state: GenerationState = {
  ...INITIAL_GENERATION_STATE,
  generationProgress: { ...EMPTY_GENERATION_PROGRESS, files: [] },
};
const listeners = new Set<Listener>();
const jobHandlers = new Set<JobHandler>();
const jobQueue: RuntimeJob[] = [];
let jobInFlight = false;

let abortController: AbortController | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let generatePromise: Promise<GenerateResult> | null = null;
let applyPromise: Promise<ApplyResult> | null = null;

function emit() {
  listeners.forEach((listener) => listener());
}

function getAbortController() {
  if (!abortController || abortController.signal.aborted) {
    abortController = new AbortController();
  }
  return abortController;
}

export function getGenerationState(): GenerationState {
  return state;
}

export function subscribeGeneration(listener: Listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function subscribeGenerationJobs(handler: JobHandler) {
  jobHandlers.add(handler);
  void drainJobs();
  return () => {
    jobHandlers.delete(handler);
  };
}

async function drainJobs() {
  if (jobInFlight || jobHandlers.size === 0) return;
  const job = jobQueue.shift();
  if (!job) return;
  const handler = jobHandlers.values().next().value;
  if (!handler) {
    jobQueue.unshift(job);
    return;
  }
  jobInFlight = true;
  try {
    await handler(job);
  } finally {
    jobInFlight = false;
    if (jobQueue.length > 0) {
      void drainJobs();
    }
  }
}

function enqueueJob(job: RuntimeJob) {
  jobQueue.push(job);
  void drainJobs();
}

export function patchGenerationState(partial: Partial<GenerationState>) {
  state = { ...state, ...partial };
  emit();
}

export function setGenerationProjectId(projectId: string | null) {
  if (state.projectId === projectId) return;
  patchGenerationState({ projectId });
}

export function setGenerationSandboxData(sandboxData: SandboxData | null) {
  patchGenerationState({ sandboxData });
}

export function setGenerationMessages(
  messages: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[]),
) {
  const next = typeof messages === 'function' ? messages(state.messages) : messages;
  patchGenerationState({ messages: next });
}

export function addGenerationMessage(
  content: string,
  type: ChatMessage['type'],
  metadata?: ChatMessage['metadata'],
) {
  setGenerationMessages((prev) => {
    if (type === 'system' && prev.length > 0) {
      const lastMessage = prev[prev.length - 1];
      if (lastMessage.type === 'system' && lastMessage.content === content) {
        return prev;
      }
    }
    return [...prev, { content, type, timestamp: new Date(), metadata }];
  });
}

/**
 * Preview-after-generation copy from persistProjectGeneration. Dedupes across the
 * apply persist path and saveCurrentProject so one generation cannot show the
 * same notice twice. Never throws — a failed notice must not fail the save.
 */
export function surfacePreviewNotice(notice: string | null | undefined) {
  if (typeof notice !== 'string' || !notice.trim()) return;
  if (state.messages.some((message) => message.content === notice)) return;
  addGenerationMessage(notice, 'system');
}

export function setGenerationProgressState(
  progress: GenerationProgressState | ((prev: GenerationProgressState) => GenerationProgressState),
) {
  const next = typeof progress === 'function' ? progress(state.generationProgress) : progress;
  patchGenerationState({
    generationProgress: next,
    streamedText: next.streamedCode,
  });
}

export function setCodeApplicationState(
  next: CodeApplicationState | ((prev: CodeApplicationState) => CodeApplicationState),
) {
  patchGenerationState({
    codeApplicationState: typeof next === 'function' ? next(state.codeApplicationState) : next,
  });
}

function fileTypeFromPath(filePath: string) {
  const fileExt = filePath.split('.').pop() || '';
  if (fileExt === 'jsx' || fileExt === 'js') return 'javascript';
  if (fileExt === 'css') return 'css';
  if (fileExt === 'json') return 'json';
  if (fileExt === 'html') return 'html';
  return 'text';
}

function applyStreamedCode(prev: GenerationProgressState, text: string): GenerationProgressState {
  const newStreamedCode = prev.streamedCode + text;
  const updatedState: GenerationProgressState = {
    ...prev,
    streamedCode: newStreamedCode,
    isStreaming: true,
    isThinking: false,
    status: 'Generating code...',
    files: [...prev.files],
  };

  // Completed fenced blocks: ```lang{path=…} … ```
  const fileRegex = new RegExp('```[^\\n`]*\\{path=([^}\\n]+)\\}\\n([^]*?)\\n```', 'g');
  const processedFiles = new Set(prev.files.map((file) => file.path));
  let match: RegExpExecArray | null;

  while ((match = fileRegex.exec(newStreamedCode)) !== null) {
    const filePath = match[1];
    const fileContent = match[2];
    if (processedFiles.has(filePath)) continue;

    const fileType = fileTypeFromPath(filePath);
    const existingFileIndex = updatedState.files.findIndex((file) => file.path === filePath);
    const nextFile: GenerationFile = {
      path: filePath,
      content: fileContent.trim(),
      type: fileType,
      completed: true,
      edited: existingFileIndex >= 0,
    };

    if (existingFileIndex >= 0) {
      updatedState.files = [
        ...updatedState.files.slice(0, existingFileIndex),
        { ...updatedState.files[existingFileIndex], ...nextFile },
        ...updatedState.files.slice(existingFileIndex + 1),
      ];
    } else {
      updatedState.files = [...updatedState.files, nextFile];
    }

    if (!prev.isEdit) {
      updatedState.status = `Completed ${filePath}`;
    }
    processedFiles.add(filePath);
  }

  // The block still streaming: an opener with no closing fence after it.
  const lastFileMatch = newStreamedCode.match(
    new RegExp('```[^\\n`]*\\{path=([^}\\n]+)\\}\\n([^]*?)$'),
  );
  if (lastFileMatch && !/\n```/.test(lastFileMatch[2])) {
    const filePath = lastFileMatch[1];
    const partialContent = lastFileMatch[2];
    if (!processedFiles.has(filePath)) {
      updatedState.currentFile = {
        path: filePath,
        content: partialContent,
        type: fileTypeFromPath(filePath),
      };
      if (!prev.isEdit) {
        updatedState.status = `Generating ${filePath}`;
      }
    }
  } else {
    updatedState.currentFile = undefined;
  }

  return updatedState;
}

async function deliverPersistPreviewNotice(response: Response, status?: GenerationStatus) {
  if (status !== 'ready' || !response.ok) return;
  try {
    const data = (await response.json().catch(() => ({}))) as { previewNotice?: unknown };
    surfacePreviewNotice(typeof data.previewNotice === 'string' ? data.previewNotice : null);
  } catch (error) {
    console.error('[generation-runtime] Failed to surface preview notice', error);
  }
}

async function persistProgress(partial: {
  status?: GenerationStatus;
  progressMessage?: string | null;
  lastCode?: string | null;
  sandboxId?: string | null;
  previewUrl?: string | null;
}) {
  const projectId = state.projectId;
  if (!projectId) return;
  try {
    const response = await fetch(`/api/projects/${projectId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(partial),
    });
    await deliverPersistPreviewNotice(response, partial.status);
  } catch (error) {
    console.error('[generation-runtime] Failed to persist progress', error);
  }
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (!state.projectId || !isActiveGenerationStatus(state.status)) {
      stopHeartbeat();
      return;
    }
    void persistProgress({
      status: state.status,
      progressMessage: state.generationProgress.status || state.status,
    });
  }, 4000);
}

function setJobStatus(status: GenerationStatus, lastError: string | null = null): Promise<void> {
  patchGenerationState({ status, lastError });
  if (isActiveGenerationStatus(status)) {
    startHeartbeat();
    void persistProgress({
      status,
      progressMessage: state.generationProgress.status || status,
    });
    return Promise.resolve();
  }
  stopHeartbeat();
  return persistProgress({
    status,
    progressMessage: lastError || state.generationProgress.status || status,
    lastCode: state.lastGeneratedCode,
    sandboxId: state.sandboxData?.sandboxId || null,
    previewUrl: state.sandboxData?.url || null,
  });
}

export function clearGeneration() {
  abortController?.abort();
  abortController = new AbortController();
  stopHeartbeat();
  generatePromise = null;
  applyPromise = null;
  state = {
    ...INITIAL_GENERATION_STATE,
    generationProgress: { ...EMPTY_GENERATION_PROGRESS, files: [] },
    messages: [],
  };
  emit();
}

export function attachToProject(projectId: string | null): GenerationState {
  if (isActiveGenerationStatus(state.status)) {
    return getGenerationState();
  }
  if (projectId && state.projectId !== projectId) {
    // The runtime is a module-level singleton that survives client-side
    // navigation. Carrying the previous project's sandboxData across meant
    // its sandboxId/previewUrl were persisted onto the NEW project's row on
    // the next status write — which then let the server's per-project file
    // cache guard mistake the old sandbox's files for this project's own.
    patchGenerationState({
      projectId,
      sandboxData: null,
      lastGeneratedCode: null,
    });
  }
  return getGenerationState();
}

export function startGeneration(input: StartGenerationInput): Promise<GenerateResult> {
  if (generatePromise && isActiveGenerationStatus(state.status)) {
    const sameProject = !input.projectId || !state.projectId || input.projectId === state.projectId;
    if (sameProject) {
      return generatePromise.then((result) => ({ ...result, alreadyRunning: true }));
    }
  }

  if (input.projectId) {
    patchGenerationState({ projectId: input.projectId });
  }
  if (input.sandboxData) {
    patchGenerationState({ sandboxData: input.sandboxData });
  }

  generatePromise = new Promise<GenerateResult>((resolve, reject) => {
    enqueueJob({
      id: `generate-${Date.now()}`,
      type: 'generate',
      input,
      resolve,
      reject,
    });
  }).finally(() => {
    generatePromise = null;
  });

  return generatePromise;
}

export function startApply(input: StartApplyInput): Promise<ApplyResult> {
  if (applyPromise && state.status === 'applying') {
    return applyPromise.then((result) => ({ ...result, alreadyRunning: true }));
  }

  applyPromise = new Promise<ApplyResult>((resolve, reject) => {
    enqueueJob({
      id: `apply-${Date.now()}`,
      type: 'apply',
      input,
      resolve,
      reject,
    });
  }).finally(() => {
    applyPromise = null;
  });

  return applyPromise;
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === 'AbortError';
}

export async function executeGenerationJob(job: RuntimeJob) {
  if (job.type === 'generate') {
    try {
      job.resolve(await runGenerateStream(job.input));
    } catch (error) {
      if (!isAbortError(error)) {
        markGenerationError(error instanceof Error ? error.message : 'Generation failed');
      }
      job.reject(error);
    }
    return;
  }
  try {
    job.resolve(await runApplyStream(job.input));
  } catch (error) {
    if (!isAbortError(error)) {
      markGenerationError(error instanceof Error ? error.message : 'Failed to apply code');
    }
    job.reject(error);
  }
}

async function runGenerateStream(input: StartGenerationInput): Promise<GenerateResult> {
  const controller = getAbortController();
  patchGenerationState({
    startedAt: Date.now(),
    lastError: null,
    status: 'generating',
  });
  setGenerationProgressState((prev) => ({
    ...prev,
    isGenerating: true,
    status: input.isEdit ? 'Starting AI generation...' : 'Initializing AI...',
    components: [],
    currentComponent: 0,
    streamedCode: '',
    isStreaming: !input.isEdit,
    isThinking: Boolean(input.isEdit),
    thinkingText: input.isEdit ? 'Analyzing your request...' : undefined,
    thinkingDuration: undefined,
    currentFile: undefined,
    lastProcessedPosition: 0,
    isEdit: input.isEdit,
    files: input.isEdit ? prev.files : prev.files || [],
  }));
  setJobStatus('generating');

  const response = await fetch('/api/generate-ai-code-stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt: input.prompt,
      model: input.model,
      styleHint: input.styleHint,
      context: input.context,
      isEdit: input.isEdit,
      projectId: input.projectId ?? state.projectId,
      idempotencyKey: input.idempotencyKey ?? undefined,
    }),
    signal: controller.signal,
  });

  const contentType = response.headers.get('content-type') || '';
  if (response.ok && contentType.includes('application/json')) {
    const body = (await response.json().catch(() => ({}))) as { reused?: boolean };
    if (body.reused) {
      return {
        generatedCode: '',
        explanation: '',
        packagesToInstall: [],
        skillNames: [],
        alreadyRunning: true,
      };
    }
  }

  if (response.status === 409) {
    const body = await response.json().catch(() => ({}));
    const conflict = parseLockConflict(409, body);
    if (conflict) emitLockConflict(conflict);
    setJobStatus('idle');
    setGenerationProgressState((prev) => ({
      ...prev,
      isGenerating: false,
      isStreaming: false,
      isThinking: false,
    }));
    return { generatedCode: '', explanation: '', packagesToInstall: [], skillNames: [] };
  }

  if (response.status === 402) {
    const body = (await response.json().catch(() => ({}))) as {
      reason?: string;
      used?: number;
      limit?: number;
      message?: string;
    };
    const denial = {
      reason: body.reason || 'workspace_exhausted',
      used: typeof body.used === 'number' ? body.used : 0,
      limit: typeof body.limit === 'number' ? body.limit : 0,
      message: body.message || "This month's credits are used up",
    };
    addGenerationMessage(denial.message, 'error', { creditDenial: denial });
    throw new Error(denial.message);
  }

  if (!response.ok || !response.body) {
    throw new Error(
      response.ok ? 'Failed to generate code' : `HTTP error! status: ${response.status}`,
    );
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let generatedCode = '';
  let explanation = '';
  let packagesToInstall: string[] = [];
  let skillNames: string[] = [];
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      try {
        const data = JSON.parse(line.slice(6));
        if (data.type === 'skills' && Array.isArray(data.names)) {
          skillNames = data.names.filter(
            (name: unknown): name is string => typeof name === 'string' && Boolean(name.trim()),
          );
          setGenerationMessages((prev) => {
            const next = [...prev];
            for (let i = next.length - 1; i >= 0; i -= 1) {
              if (next[i].type === 'user') {
                next[i] = {
                  ...next[i],
                  metadata: { ...next[i].metadata, skillNames },
                };
                break;
              }
            }
            return next;
          });
        } else if (data.type === 'status') {
          setGenerationProgressState((prev) => ({ ...prev, status: data.message }));
        } else if (data.type === 'thinking') {
          setGenerationProgressState((prev) => ({
            ...prev,
            isThinking: true,
            thinkingText: (prev.thinkingText || '') + data.text,
          }));
        } else if (data.type === 'thinking_complete') {
          setGenerationProgressState((prev) => ({
            ...prev,
            isThinking: false,
            thinkingDuration: data.duration,
          }));
        } else if (data.type === 'conversation') {
          let text = data.text || '';
          text = text.replace(/<package>[^<]*<\/package>/g, '');
          text = text.replace(/<packages>[^<]*<\/packages>/g, '');
          if (
            !text.includes('<file') &&
            !text.includes('import React') &&
            !text.includes('export default') &&
            !text.includes('className=') &&
            text.trim().length > 0
          ) {
            addGenerationMessage(text.trim(), 'ai');
          }
        } else if (data.type === 'stream' && data.raw) {
          setGenerationProgressState((prev) => applyStreamedCode(prev, data.text));
        } else if (data.type === 'app') {
          setGenerationProgressState((prev) => ({
            ...prev,
            status: 'Generated App.jsx structure',
          }));
        } else if (data.type === 'component') {
          setGenerationProgressState((prev) => ({
            ...prev,
            status: `Generated ${data.name}`,
            components: [...prev.components, { name: data.name, path: data.path, completed: true }],
            currentComponent: data.index,
          }));
        } else if (data.type === 'package') {
          setGenerationProgressState((prev) => ({
            ...prev,
            status: data.message || `Installing ${data.name}`,
          }));
        } else if (data.type === 'complete') {
          generatedCode = data.generatedCode || '';
          explanation = data.explanation || '';
          packagesToInstall = data.packagesToInstall || [];
          if (Array.isArray(data.skillNames) && data.skillNames.length > 0) {
            skillNames = data.skillNames.filter(
              (name: unknown): name is string => typeof name === 'string',
            );
          }
          if (packagesToInstall.length > 0 && typeof window !== 'undefined') {
            (window as unknown as { pendingPackages?: string[] }).pendingPackages =
              packagesToInstall;
          }
          patchGenerationState({ lastGeneratedCode: generatedCode || null });
          // Completed fenced blocks: ```lang{path=…} … ```
          const fileRegex = new RegExp('```[^\\n`]*\\{path=([^}\\n]+)\\}\\n([^]*?)\\n```', 'g');
          const parsedFiles: GenerationFile[] = [];
          let fileMatch: RegExpExecArray | null;
          while (generatedCode && (fileMatch = fileRegex.exec(generatedCode)) !== null) {
            parsedFiles.push({
              path: fileMatch[1],
              content: fileMatch[2].trim(),
              type: fileTypeFromPath(fileMatch[1]),
              completed: true,
            });
          }
          setGenerationProgressState((prev) => ({
            ...prev,
            status: `Generated ${parsedFiles.length > 0 ? parsedFiles.length : prev.files.length} file${(parsedFiles.length > 0 ? parsedFiles.length : prev.files.length) !== 1 ? 's' : ''}!`,
            isGenerating: false,
            isStreaming: false,
            isThinking: false,
            thinkingText: undefined,
            thinkingDuration: undefined,
            files: prev.files.length > 0 ? prev.files : parsedFiles,
          }));
        } else if (data.type === 'error') {
          throw new Error(data.error || 'Generation failed');
        } else if (data.type === 'warning' || data.type === 'info') {
          // Same handling as the apply branch below. The route's degraded-context
          // notices ("could not read your files, working blind") arrive on these
          // two frames; without a case here they were parsed and discarded.
          if (data.message) {
            addGenerationMessage(data.message, 'system');
          }
        }
      } catch (error) {
        if (error instanceof SyntaxError) {
          console.error('Failed to parse SSE data:', error);
          continue;
        }
        throw error;
      }
    }
  }

  if (!generatedCode) {
    setJobStatus('error', 'Failed to generate recreation');
    setGenerationProgressState((prev) => ({
      ...prev,
      isGenerating: false,
      isStreaming: false,
    }));
    throw new Error('Failed to generate recreation');
  }

  setGenerationProgressState((prev) => ({
    ...prev,
    isGenerating: false,
    isStreaming: false,
    isThinking: false,
    thinkingText: undefined,
    thinkingDuration: undefined,
    status: 'Generation complete!',
  }));

  return { generatedCode, explanation, packagesToInstall, skillNames };
}

async function runApplyStream(input: StartApplyInput): Promise<ApplyResult> {
  const controller = getAbortController();
  setJobStatus('applying');
  setCodeApplicationState({ stage: 'analyzing' });

  const response = await fetch('/api/apply-ai-code-stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      response: input.code,
      isEdit: input.isEdit,
      packages: input.packages || [],
      sandboxId: input.sandboxId,
      projectId: state.projectId,
    }),
    signal: controller.signal,
  });

  if (response.status === 409) {
    const body = await response.json().catch(() => ({}));
    const conflict = parseLockConflict(409, body);
    if (conflict) emitLockConflict(conflict);
    setJobStatus('idle');
    return { finalData: null };
  }

  if (!response.ok) {
    throw new Error(`Failed to apply code: ${response.statusText}`);
  }

  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  let finalData: Record<string, unknown> | null = null;

  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;

    const chunk = decoder.decode(value);
    const lines = chunk.split('\n');

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      try {
        const data = JSON.parse(line.slice(6));
        switch (data.type) {
          case 'start':
            setCodeApplicationState({ stage: 'analyzing' });
            break;
          case 'step':
            if (data.message?.includes('Installing') && data.packages) {
              setCodeApplicationState({ stage: 'installing', packages: data.packages });
            } else if (
              data.message?.includes('Creating files') ||
              data.message?.includes('Applying')
            ) {
              setCodeApplicationState({ stage: 'applying', filesGenerated: [] });
            }
            break;
          case 'package-progress':
          case 'success':
            if (data.installedPackages) {
              setCodeApplicationState((prev) => ({
                ...prev,
                installedPackages: data.installedPackages,
              }));
            }
            break;
          case 'command':
            if (data.command && !data.command.includes('npm install')) {
              addGenerationMessage(data.command, 'command', { commandType: 'input' });
            }
            break;
          case 'command-progress':
            addGenerationMessage(`${data.action} command: ${data.command}`, 'command', {
              commandType: 'input',
            });
            break;
          case 'command-output':
            addGenerationMessage(data.output, 'command', {
              commandType: data.stream === 'stderr' ? 'error' : 'output',
            });
            break;
          case 'command-complete':
            addGenerationMessage(
              data.success
                ? 'Command completed successfully'
                : `Command failed with exit code ${data.exitCode}`,
              'system',
            );
            break;
          case 'complete':
            finalData = data;
            setCodeApplicationState({ stage: 'complete' });
            setTimeout(() => {
              setCodeApplicationState({ stage: null });
            }, 3000);
            break;
          case 'error':
            addGenerationMessage(
              `Error: ${data.message || data.error || 'Unknown error'}`,
              'system',
            );
            break;
          case 'warning':
          case 'info':
            if (data.message) {
              addGenerationMessage(data.message, 'system');
            }
            break;
          default:
            break;
        }
      } catch {
        // Ignore parse errors for partial SSE chunks
      }
    }
  }

  if (finalData) {
    patchGenerationState({ lastGeneratedCode: input.code });
    await setJobStatus('ready');
  }

  return { finalData };
}

export function markGenerationError(message: string) {
  patchGenerationState({ lastError: message });
  setJobStatus('error', message);
  setGenerationProgressState((prev) => ({
    ...prev,
    isGenerating: false,
    isStreaming: false,
    status: '',
  }));
}

export function markGenerationReady() {
  setGenerationProgressState((prev) => ({
    ...prev,
    isGenerating: false,
    isStreaming: false,
    isThinking: false,
    thinkingText: undefined,
    thinkingDuration: undefined,
    status: 'Generation complete!',
    isEdit: false,
  }));
  setJobStatus('ready');
}
