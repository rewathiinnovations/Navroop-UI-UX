'use client';

import { useState, type ReactNode, type RefObject } from 'react';
import { cn } from '@/utils/cn';
import '@/components/app/studio/studio.css';
import ChatInput from './ChatInput';
import ChatPanel from './ChatPanel';
import PreviewPanel from './PreviewPanel';
import AssetsPanel from './AssetsPanel';
import BrainPanel from './BrainPanel';
import QualityPanel from './QualityPanel';
import VersionHistoryPanel from './VersionHistoryPanel';
import WorkspaceTopBar from './WorkspaceTopBar';
import { useCheckpoints } from './useCheckpoints';
import { useProjectSandbox } from './useProjectSandbox';
import { useProjectPlan } from './useProjectPlan';
import type {
  ProjectPhase,
  SaveStatus,
  SendMessageOptions,
  ViewportSize,
  WorkspacePage,
  WorkspacePlan,
  WorkspaceView,
} from './types';
import type { ChatMessage } from '@/lib/generation/types';

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
  viewport,
  onViewportChange,
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
  initialPhase = null,
  initialPlan = null,
  isJobActive = false,
  generationStatus = null,
  onStartApprovedBuild,
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
  viewport: ViewportSize;
  onViewportChange: (viewport: ViewportSize) => void;
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
  initialPhase?: ProjectPhase | null;
  initialPlan?: WorkspacePlan | null;
  isJobActive?: boolean;
  generationStatus?: string | null;
  onStartApprovedBuild?: (promptContext: string) => void;
  onThreadMessage?: (content: string, type: 'user' | 'system') => void;
}) {
  const [chatCollapsed, setChatCollapsed] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
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
  const sandbox = useProjectSandbox({
    projectId,
    phase,
    iframeRef,
  });

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

  const share = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
    } catch {
      /* clipboard may be blocked — do not claim success */
    }
  };

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
        viewport={viewport}
        onViewportChange={onViewportChange}
        chatCollapsed={chatCollapsed}
        onToggleChat={() => setChatCollapsed((value) => !value)}
        onOpenHistory={() => setHistoryOpen(true)}
        onRefresh={onRefresh}
        onShare={share}
        projectId={projectId}
        githubConnected={githubConnected}
        githubRepoUrl={githubRepoUrl}
        sourceUrl={sourceUrl}
      />

      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        <section
          className={cn(
            'flex h-full shrink-0 flex-col border-r border-[var(--studio-line)] bg-[var(--studio-surface)] transition-[width,opacity] duration-200',
            chatCollapsed ? 'w-0 overflow-hidden opacity-0' : 'w-[380px] opacity-100',
          )}
          aria-hidden={chatCollapsed}
        >
          <ChatPanel
            messages={messages}
            projectId={projectId}
            isGenerating={sending || refining}
            header={chatHeader}
            onPreviewCheckpoint={(id) => {
              void previewCheckpoint(id).then((result) => {
                if (!result.ok) onThreadMessage?.(result.error, 'system');
              });
              onPreviewCheckpoint?.(id);
            }}
            latestCheckpoint={latestCheckpoint}
            phase={phase}
            plan={plan}
            approving={approving}
            onApprovePlan={handleApprove}
          />
          <ChatInput
            projectId={projectId}
            onSend={handleSend}
            sending={sending || refining || approving}
            phase={phase}
            sandboxLocked={sandbox.chatLocked}
          />
        </section>

        <PreviewPanel
          iframeRef={iframeRef}
          sandboxUrl={sandbox.previewUrl || sandboxUrl}
          selectedPage={selectedPage}
          viewport={viewport}
          expanded={chatCollapsed}
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
          ) : (
            preview
          )}
        </PreviewPanel>

        <VersionHistoryPanel
          open={historyOpen}
          onClose={() => setHistoryOpen(false)}
          checkpoints={checkpoints}
          onRestore={(id) => {
            void restore(id).then((result) => {
              if (!result.ok && result.error !== 'cancelled') {
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
