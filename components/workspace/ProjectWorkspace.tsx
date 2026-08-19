'use client';

import { useEffect, useState, type ReactNode, type RefObject } from 'react';
import { cn } from '@/utils/cn';
import '@/components/app/studio/studio.css';
import ChatInput from './ChatInput';
import ChatPanel from './ChatPanel';
import PreviewPanel from './PreviewPanel';
import { BrowserPreview } from './BrowserPreview';
import type { GenerationFile } from '@/lib/generation/types';
import StreamingCodePanel from './StreamingCodePanel';
import { useProjectFiles } from './useProjectFiles';
import AssetsPanel from './AssetsPanel';
import BrainPanel from './BrainPanel';
import DomainsPanel from './DomainsPanel';
import QualityPanel from './QualityPanel';
import VersionHistoryPanel from './VersionHistoryPanel';
import ProductTour from './ProductTour';
import WorkspaceTopBar from './WorkspaceTopBar';
import { useCheckpoints } from './useCheckpoints';
import { useStaticPreview } from './useStaticPreview';
import { useLivePreviewMode } from './useLivePreviewMode';
import { useProjectPlan } from './useProjectPlan';
import { PREVIEW_DEVICE_EVENT } from '@/lib/preview/devices';
import { usePreviewDevice } from './usePreviewDevice';
import type {
  ProjectPhase,
  SaveStatus,
  SendMessageOptions,
  WorkspacePage,
  WorkspacePlan,
  WorkspaceView,
} from './types';
import type { ChatMessage } from '@/lib/generation/types';
import PanelErrorBoundary from '@/components/errors/PanelErrorBoundary';
import LockBar from './LockBar';
import StaleViewBanner from './StaleViewBanner';
import { useProjectPresence } from './useProjectPresence';
import { isJobInFlight, showsChatRecovery } from '@/lib/jobs/chat-ui';
import { offersRecoveryKeep, recoveryNextStepLine } from '@/lib/jobs/copy';
import { dispatchRecoveryRetry, recoveryRetryIntent } from '@/lib/jobs/recovery-retry';
import type { ImportMode } from '@/lib/import/mode';
import { useGenerationJob } from './useGenerationJob';
import { notify } from '@/lib/notify';

export default function ProjectWorkspace({
  projectId,
  projectName,
  saveState,
  updatedAt,
  onRename,
  messages,
  onSend,
  sending,
  pages,
  selectedPage,
  onSelectPage,
  view,
  onViewChange,
  onRefresh,
  iframeRef,
  sandboxUrl,
  preview,
  chatHeader,
  onPreviewCheckpoint,
  onRestoreCheckpoint,
  githubConnected = false,
  githubRepoUrl = null,
  sourceUrl = null,
  importMode = null,
  initialPhase = null,
  initialPlan = null,
  isJobActive = false,
  streamFiles = null,
  streamedText = null,
  generationStatus = null,
  onStartApprovedBuild,
  onRetryImport,
  onRetryPlan,
  onThreadMessage,
}: {
  projectId: string | null;
  projectName: string;
  saveState: SaveStatus;
  updatedAt: string | null;
  onRename: (name: string) => void;
  messages: ChatMessage[];
  onSend: (text: string, options: SendMessageOptions) => void;
  sending: boolean;
  pages: WorkspacePage[];
  selectedPage: string;
  onSelectPage: (path: string) => void;
  view: WorkspaceView;
  onViewChange: (view: WorkspaceView) => void;
  onRefresh: () => void;
  iframeRef?: RefObject<HTMLIFrameElement | null>;
  sandboxUrl?: string | null;
  preview: ReactNode;
  chatHeader?: ReactNode;
  onPreviewCheckpoint?: (id: string) => void;
  onRestoreCheckpoint?: (id: string) => void;
  githubConnected?: boolean;
  githubRepoUrl?: string | null;
  sourceUrl?: string | null;
  importMode?: ImportMode | null;
  initialPhase?: ProjectPhase | null;
  initialPlan?: WorkspacePlan | null;
  isJobActive?: boolean;
  /**
   * The live generation's files, straight from `GenerationProgressState.files`.
   * Carries at most one trailing `completed: false` entry, so the preview can
   * layer only finished files and never hand esbuild a half-written module.
   */
  streamFiles?: GenerationFile[] | null;
  /** Raw reply so far, shown only until the first file appears. */
  streamedText?: string | null;
  generationStatus?: string | null;
  onStartApprovedBuild?: (promptContext: string) => void;
  onRetryImport?: (source: { sourceUrl: string; mode: ImportMode }) => void | Promise<void>;
  onRetryPlan?: (prompt: string) => void | Promise<void>;
  onThreadMessage?: (content: string, type: 'user' | 'system') => void;
}) {
  const [chatCollapsed, setChatCollapsed] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  /**
   * Which checkpoint the reader asked to see, so the matching header pill reads as
   * selected. It is only ever trusted while `previewing` is true — the hook owns
   * whether a preview is on at all, so this cannot outlive one.
   */
  const [previewedVersionId, setPreviewedVersionId] = useState<string | null>(null);
  const previewDevice = usePreviewDevice();
  const { phase, plan, refining, approving, refine, approve, watchForPlan } = useProjectPlan({
    projectId,
    initialPhase,
    initialPlan,
    isJobActive,
    generationStatus,
  });
  const {
    checkpoints,
    latestCheckpoint,
    previewing,
    preview: previewCheckpoint,
    exitPreview,
    restore,
    bookmark,
  } = useCheckpoints({
    projectId,
    isJobActive,
    generationStatus,
    onRefresh,
  });
  const staticPreview = useStaticPreview({
    projectId,
    enabled: true,
    iframeRef,
    selectedPage,
  });
  const livePreview = useLivePreviewMode({
    // `shouldEnterLiveMode` inside the hook is what refuses a FAILED build now.
    // ORing `status === 'FAILED'` into `lockedOn` here is exactly what used to
    // force live mode on for a failed build; the call site must not re-derive it.
    lockedOn: staticPreview.lockedLive,
    staticStatus: staticPreview.status,
  });
  // Live mode has no URL of its own any more — the sandbox VM that served one went
  // away with `20260819010000_drop_sandbox_columns`, so both branches end at the
  // snapshot URL the server hands down.
  const previewUrl = livePreview.enabled ? sandboxUrl : staticPreview.previewUrl || sandboxUrl;
  const presence = useProjectPresence(projectId, {
    selfBusy: isJobActive || generationStatus === 'ready' || generationStatus === 'applying',
  });
  const generationJob = useGenerationJob({ projectId, phase, isJobActive });
  const projectFiles = useProjectFiles(projectId);

  // Derived once and used by both the pane choice and `hasFiles`, because those two
  // disagreeing is what produced the original symptom: `hasFiles` said 'empty', which
  // made `previewPaneKind` short-circuit this panel's children, so whatever the pane
  // would have rendered never mounted at all.
  const hasStoredFiles = Object.keys(projectFiles.files).length > 0;
  const hasFinishedStreamedFile = streamFiles?.some((file) => file.completed) ?? false;
  const nothingRenderableYet = !hasStoredFiles && !hasFinishedStreamedFile;

  const handleSend = (text: string, options: SendMessageOptions) => {
    if (phase === 'PLANNING') {
      onThreadMessage?.(text, 'user');
      void refine(text).then((result) => {
        if (!result.ok) onThreadMessage?.(result.error, 'system');
      });
      return;
    }
    if (options.mode === 'plan') watchForPlan();
    onSend(text, options);
  };

  const handleApprove = () => {
    void approve().then((result) => {
      if (!result.ok) {
        onThreadMessage?.(result.error, 'system');
        return;
      }
      if (result.promptContext) onStartApprovedBuild?.(result.promptContext);
    });
  };

  /**
   * The one preview-a-checkpoint path, shared by the chat's version button and the
   * header's version pills. `locked` stays silent because the client already raised
   * the LockBar for that conflict, and saying it again as a chat line says it twice.
   */
  const handlePreviewCheckpoint = (id: string) => {
    void previewCheckpoint(id).then((result) => {
      if (result.ok) {
        setPreviewedVersionId(id);
        return;
      }
      if (!('locked' in result && result.locked)) onThreadMessage?.(result.error, 'system');
    });
    onPreviewCheckpoint?.(id);
  };

  const recoveryErrorCode =
    generationJob.clientStop === 'timeout' ? 'timeout' : generationJob.job?.errorCode;
  const retryIntent = recoveryRetryIntent({
    kind: generationJob.job?.kind,
    errorCode: recoveryErrorCode,
    errorMessage: generationJob.job?.errorMessage,
    sourceUrl,
    importMode,
    inputPrompt: generationJob.job?.inputPrompt,
  });

  const handleRetry = () => {
    const intent = retryIntent;
    if (intent.action === 'import') {
      void dispatchRecoveryRetry(intent, {
        startImport: async (source) => {
          await onRetryImport?.(source);
        },
        startPlan: async () => undefined,
        startBuild: async () => undefined,
        createRetryJob: async () => ({ ok: true as const }),
      }).catch((error: unknown) => {
        onThreadMessage?.(error instanceof Error ? error.message : 'Import failed', 'system');
      });
      return;
    }
    if (intent.action === 'plan') {
      void dispatchRecoveryRetry(intent, {
        startImport: async () => undefined,
        startPlan: async (prompt) => {
          await onRetryPlan?.(prompt);
          watchForPlan();
          await generationJob.refresh();
        },
        startBuild: async () => undefined,
        createRetryJob: async () => ({ ok: true as const }),
      }).catch((error: unknown) => {
        onThreadMessage?.(
          error instanceof Error ? error.message : 'Could not start a plan.',
          'system',
        );
      });
      return;
    }
    const key =
      typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : `retry-${Date.now()}`;
    void dispatchRecoveryRetry(intent, {
      startImport: async () => undefined,
      startPlan: async () => undefined,
      startBuild: async (prompt) => {
        onStartApprovedBuild?.(prompt);
      },
      createRetryJob: async () => {
        const result = await generationJob.retry(key);
        if (!result.ok) {
          onThreadMessage?.(result.error, 'system');
          return { ok: false as const, error: result.error };
        }
        return { ok: true as const, prompt: result.prompt };
      },
    });
  };

  const handleKeep = () => {
    void generationJob.keep().then((result) => {
      if (!result.ok) onThreadMessage?.(result.error, 'system');
    });
  };

  const handleStartOver = () => {
    void generationJob.startOver().then((result) => {
      if (!result.ok) onThreadMessage?.(result.error, 'system');
    });
  };

  const share = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      notify.success('Project link copied.', { key: 'workspace-share' });
    } catch {
      // Never claim success the clipboard did not give us.
      notify.warning('Could not copy — copy the address bar by hand.', {
        key: 'workspace-share',
      });
    }
  };

  useEffect(() => {
    const onPreviewDevice = () => {
      onViewChange('preview');
    };
    window.addEventListener(PREVIEW_DEVICE_EVENT, onPreviewDevice);
    return () => window.removeEventListener(PREVIEW_DEVICE_EVENT, onPreviewDevice);
  }, [onViewChange]);

  return (
    <div className="studio-shell relative flex h-dvh flex-col overflow-hidden">
      <WorkspaceTopBar
        projectName={projectName}
        saveState={saveState}
        updatedAt={updatedAt}
        onRename={onRename}
        view={view}
        onViewChange={onViewChange}
        pages={pages}
        selectedPage={selectedPage}
        onSelectPage={onSelectPage}
        chatCollapsed={chatCollapsed}
        onToggleChat={() => setChatCollapsed((value) => !value)}
        onOpenHistory={() => setHistoryOpen(true)}
        onRefresh={onRefresh}
        onShare={share}
        previewUrl={previewUrl}
        previewDevice={previewDevice.device}
        previewRotated={previewDevice.rotated}
        onPreviewDeviceChange={previewDevice.setDevice}
        onTogglePreviewRotate={previewDevice.toggleRotate}
        projectId={projectId}
        githubConnected={githubConnected}
        githubRepoUrl={githubRepoUrl}
        sourceUrl={sourceUrl}
        presenceViewers={presence.others}
        checkpoints={checkpoints}
        activeVersionId={previewing ? previewedVersionId : null}
        onPreviewVersion={handlePreviewCheckpoint}
      />
      <StaleViewBanner
        visible={presence.stale}
        onRefresh={() => {
          window.location.reload();
        }}
      />
      {presence.peerNote ? (
        <div
          className="border-b border-[var(--studio-line)] bg-[var(--studio-surface)] px-12 py-8 text-[12px] text-[var(--studio-muted)]"
          role="status"
        >
          {presence.peerNote}
        </div>
      ) : null}

      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        <section
          data-tour="chat"
          className={cn(
            'flex h-full shrink-0 flex-col border-r border-[var(--studio-line)] bg-[var(--studio-surface)] transition-[width,opacity] duration-200',
            chatCollapsed ? 'w-0 overflow-hidden opacity-0' : 'w-[380px] opacity-100',
          )}
          aria-hidden={chatCollapsed}
        >
          <PanelErrorBoundary label="Chat">
            <ChatPanel
              messages={messages}
              projectId={projectId}
              isGenerating={
                (sending || refining) &&
                !generationJob.recovery &&
                (!generationJob.job || isJobInFlight(generationJob.job.status))
              }
              header={chatHeader}
              onPreviewCheckpoint={handlePreviewCheckpoint}
              latestCheckpoint={latestCheckpoint}
              phase={phase}
              jobStatus={generationJob.job?.status}
              plan={plan}
              approving={approving}
              onApprovePlan={handleApprove}
              queueAhead={generationJob.job?.queuePosition}
              recovery={
                generationJob.recovery && showsChatRecovery(generationJob.job?.kind)
                  ? {
                      visible: true,
                      kind: generationJob.job?.kind,
                      errorCode:
                        generationJob.clientStop === 'timeout'
                          ? 'timeout'
                          : generationJob.job?.errorCode,
                      errorMessage: generationJob.job?.errorMessage,
                      filesWritten: generationJob.job?.filesWritten ?? 0,
                      requestId: generationJob.job?.requestId,
                      busy: generationJob.busy,
                      onKeep: offersRecoveryKeep({
                        kind: generationJob.job?.kind,
                        filesWritten: generationJob.job?.filesWritten ?? 0,
                      })
                        ? handleKeep
                        : undefined,
                      onRetry: handleRetry,
                      offerRetry: retryIntent.action !== 'none',
                      nextStep:
                        retryIntent.action === 'none'
                          ? retryIntent.nextStep
                          : recoveryNextStepLine({
                              kind: generationJob.job?.kind,
                              errorCode: recoveryErrorCode,
                              errorMessage: generationJob.job?.errorMessage,
                            }),
                      onStartOver: handleStartOver,
                      resourceIds: generationJob.job?.resourceIds,
                    }
                  : null
              }
            />
            <LockBar
              lock={
                presence.heldByOther
                  ? presence.lock
                  : { locked: false, heldBy: null, expiresAt: null, reason: null }
              }
              showRelease={presence.heldByOther && presence.isAdmin}
              onRelease={() => {
                void presence.releaseLock();
              }}
            />
            <ChatInput
              projectId={projectId}
              onSend={handleSend}
              sending={sending || refining || approving}
              phase={phase}
              jobStatus={generationJob.job?.status}
              projectLocked={presence.heldByOther}
              recoveryActive={generationJob.recovery && showsChatRecovery(generationJob.job?.kind)}
            />
          </PanelErrorBoundary>
        </section>

        <PanelErrorBoundary label="Preview">
          <PreviewPanel
            iframeRef={iframeRef}
            sandboxUrl={previewUrl}
            // Streamed files count too, not just persisted ones, and so does a build
            // that has not written one yet. `hasFiles` decides `previewPaneKind`, and
            // 'empty' short-circuits this panel's children — so on a first build the
            // pane stayed on "Nothing to preview yet" and the preview below was never
            // mounted at all, no matter what it was handed. `isJobActive` covers the
            // first seconds, when Code owes the reader the streaming panel's own
            // "code appears here as it is written" state rather than EmptyPreview.
            hasFiles={isJobActive || hasStoredFiles || hasFinishedStreamedFile}
            selectedPage={selectedPage}
            expanded={chatCollapsed}
            previewDevice={previewDevice.device}
            previewRotated={previewDevice.rotated}
            view={view}
            onSend={handleSend}
            sending={sending}
            phase={phase}
            planTrigger={plan?.trigger}
            previewing={previewing}
            onExitPreview={() => {
              void exitPreview().then((result) => {
                if (!result.ok && !('locked' in result && result.locked)) {
                  onThreadMessage?.(result.error, 'system');
                }
              });
            }}
            previewKind={livePreview.enabled ? 'live' : 'static'}
            preparingPreview={staticPreview.preparing && !livePreview.enabled}
            previewBuildFailed={staticPreview.status === 'FAILED'}
            previewBuildLog={staticPreview.buildLog}
            onRetryPreview={() => {
              void staticPreview.retry();
            }}
          >
            {view === 'seo' && projectId ? (
              <QualityPanel
                projectId={projectId}
                projectUpdatedAt={updatedAt}
                onSend={handleSend}
                sending={sending}
              />
            ) : view === 'assets' && projectId ? (
              <AssetsPanel projectId={projectId} />
            ) : view === 'brain' && projectId ? (
              <BrainPanel projectId={projectId} />
            ) : view === 'domains' && projectId ? (
              <DomainsPanel projectId={projectId} />
            ) : view === 'preview' && projectId ? (
              // Two things can occupy the preview pane during a build.
              //
              // If there is anything renderable — stored files from an earlier build,
              // or a file this stream has already finished — the compiled preview
              // stays up. It only layers `completed: true` files, so a half-written
              // module never reaches esbuild, and a failed intermediate compile keeps
              // the last good frame rather than blanking a working page.
              //
              // If there is nothing renderable yet — a first build, minutes before the
              // model closes its first fence — the pane shows the code as it arrives
              // instead of a spinner. It used to sit on "Waiting for the first files…"
              // while the only view that could show the work was one tab away, which
              // reads as a hang. Watching the file being typed is the point; the
              // compiled page takes over the moment there is a page to compile.
              nothingRenderableYet ? (
                <StreamingCodePanel
                  files={streamFiles ?? []}
                  status={generationStatus}
                  streamedText={streamedText}
                  className="h-full"
                />
              ) : (
                <BrowserPreview
                  stack={projectFiles.stack}
                  files={projectFiles.files}
                  stream={isJobActive && streamFiles ? { files: streamFiles, active: true } : null}
                />
              )
            ) : (
              preview
            )}
          </PreviewPanel>
        </PanelErrorBoundary>

        <ProductTour />
        <VersionHistoryPanel
          open={historyOpen}
          onClose={() => setHistoryOpen(false)}
          projectId={projectId}
          checkpoints={checkpoints}
          onRestore={(id) => {
            void restore(id).then((result) => {
              if (
                !result.ok &&
                result.error !== 'cancelled' &&
                !('locked' in result && result.locked)
              ) {
                onThreadMessage?.(result.error, 'system');
              }
            });
            onRestoreCheckpoint?.(id);
          }}
          onBookmark={(id) => {
            void bookmark(id).then((result) => {
              if (!result.ok && !('locked' in result && result.locked)) {
                onThreadMessage?.(result.error, 'system');
              }
            });
          }}
        />
      </div>
    </div>
  );
}
