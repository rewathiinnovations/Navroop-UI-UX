'use client';

import { useEffect, useState, type ReactNode, type RefObject } from 'react';
import { cn } from '@/utils/cn';
import '@/components/app/studio/studio.css';
import ChatInput from './ChatInput';
import ChatPanel from './ChatPanel';
import PreviewPanel from './PreviewPanel';
import { BrowserPreview } from './BrowserPreview';
import { useProjectFiles } from './useProjectFiles';
import AssetsPanel from './AssetsPanel';
import BrainPanel from './BrainPanel';
import DomainsPanel from './DomainsPanel';
import QualityPanel from './QualityPanel';
import VersionHistoryPanel from './VersionHistoryPanel';
import ProductTour from './ProductTour';
import WorkspaceTopBar from './WorkspaceTopBar';
import { useCheckpoints } from './useCheckpoints';
import { useProjectSandbox } from './useProjectSandbox';
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
  generationStatus?: string | null;
  onStartApprovedBuild?: (promptContext: string) => void;
  onRetryImport?: (source: { sourceUrl: string; mode: ImportMode }) => void | Promise<void>;
  onRetryPlan?: (prompt: string) => void | Promise<void>;
  onThreadMessage?: (content: string, type: 'user' | 'system') => void;
}) {
  const [chatCollapsed, setChatCollapsed] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
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
    projectId,
    lockedOn: staticPreview.lockedLive || staticPreview.status === 'FAILED',
  });
  const sandbox = useProjectSandbox({
    projectId,
    phase,
    iframeRef,
    liveMode: livePreview.enabled,
  });
  const previewUrl = livePreview.enabled
    ? sandbox.previewUrl || sandboxUrl
    : staticPreview.previewUrl || sandbox.previewUrl || sandboxUrl;
  const presence = useProjectPresence(projectId, {
    selfBusy: isJobActive || generationStatus === 'ready' || generationStatus === 'applying',
  });
  const generationJob = useGenerationJob({ projectId, phase, isJobActive });
  const projectFiles = useProjectFiles(projectId);

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
              onPreviewCheckpoint={(id) => {
                void previewCheckpoint(id).then((result) => {
                  if (!result.ok) onThreadMessage?.(result.error, 'system');
                });
                onPreviewCheckpoint?.(id);
              }}
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
              sandboxLocked={sandbox.chatLocked}
              projectLocked={presence.heldByOther}
              recoveryActive={generationJob.recovery && showsChatRecovery(generationJob.job?.kind)}
            />
          </PanelErrorBoundary>
        </section>

        <PanelErrorBoundary label="Preview">
          <PreviewPanel
            iframeRef={iframeRef}
            sandboxUrl={previewUrl}
            hasFiles={Object.keys(projectFiles.files).length > 0}
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
                if (!result.ok) onThreadMessage?.(result.error, 'system');
              });
            }}
            sandboxState={sandbox}
            onRetrySandbox={() => {
              void sandbox.boot();
            }}
            previewKind={livePreview.enabled ? 'live' : 'static'}
            preparingPreview={staticPreview.preparing && !livePreview.enabled}
            previewBuildFailed={staticPreview.status === 'FAILED'}
            previewBuildLog={staticPreview.buildLog}
            onRetryPreview={() => {
              void staticPreview.retry();
            }}
            onStartLive={() => {
              void livePreview.startLive();
            }}
            liveNotice={livePreview.notice}
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
            ) : view === 'preview' && projectId && !isJobActive ? (
              // Compiled and run in this browser from the project's stored
              // files. `preview` still owns the generation view, which streams
              // code into the file explorer while a build is running.
              <BrowserPreview stack={projectFiles.stack} files={projectFiles.files} />
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
              if (!result.ok) onThreadMessage?.(result.error, 'system');
            });
          }}
        />
      </div>
    </div>
  );
}
