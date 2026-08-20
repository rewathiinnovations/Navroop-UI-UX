'use client';

import { useState, useEffect, useMemo, useRef, Suspense } from 'react';
import { useSearchParams, useRouter, useParams } from 'next/navigation';
import { appConfig } from '@/config/app.config';
import SidebarInput from '@/components/app/generation/SidebarInput';
import ProjectWorkspace from '@/components/workspace/ProjectWorkspace';
import { pagesFromFiles } from '@/components/workspace/pages-from-files';
import {
  hasExistingSite,
  hasStoredSite,
  sendOutcomeForStream,
  SEND_FAILED,
  shouldRequestFollowUpPlan,
  SEND_REFUSED_ALREADY_RUNNING,
  type ChatMode,
  type MessageSource,
  type ProjectPhase,
  type WorkspacePlan,
  type WorkspaceView,
} from '@/components/workspace/types';
import GenerationCodeView from '@/components/workspace/GenerationCodeView';
import CodeApplicationProgress from '@/components/CodeApplicationProgress';
import { persistProject } from '@/lib/projects/persist-client';
import { decidePendingPromptAction } from '@/lib/projects/pending-prompt';
import { projectDisplayName } from '@/lib/projects/prompt';
import { takeProjectArm } from '@/lib/projects/start-from-prompt';
import { streamProjectImport } from '@/lib/import/client';
import { retryProjectPlan } from '@/lib/projects/plan-client';
import { DEFAULT_IMPORT_MODE, resolveImportMode, type ImportMode } from '@/lib/import/mode';
import { useGeneration } from '@/components/app/generation/GenerationProvider';
import { applyPageCopy, shouldAddApplyChat } from '@/lib/generation/apply-page-copy';
import { getGenerationState, surfacePreviewNotice } from '@/lib/generation/generation-runtime';
import { appliedPathsFromReply } from '@/lib/generation/parse-blocks';
import { screenshotErrorMessage } from '@/lib/generation/screenshot-error';
import {
  type BrandingData,
  type BuildFixRequest,
  type ChatMessage,
  // Not re-declared here. The local `interface SandboxData` was a byte-identical shadow of
  // this one, and the values it typed all come from the provider, which is typed with the
  // shared interface — so the shadow could drift out of step with the thing it described
  // without a single type error (F-097).
  type SandboxData,
} from '@/lib/generation/types';
import { streamingFilesLabel } from './BuildingIndicator';
import { toMessage } from '@/lib/notify';

/**
 * Stays local, unlike `ChatMessage` and `SandboxData`: there is no shared counterpart to
 * import (F-097). It describes the shape this component hands to its own conversation
 * context from the importer's result, and nothing outside this file consumes it.
 */
interface ScrapeData {
  success: boolean;
  content?: string;
  url?: string;
  title?: string;
  source?: string;
  screenshot?: string;
  structured?: unknown;
  metadata?: unknown;
  message?: string;
  error?: string;
}

/**
 * Firecrawl's branding object as `/api/extract-brand-styles` returns it. A
 * superset of the shared `BrandingData`, because the brand-extension prompt
 * below also reads `colors.link`, `typography.fontStacks`, `components.input`,
 * `designSystem` and `images`, none of which that shared type declares. The
 * overlapping fields are not restated here so there stays one source of truth.
 */
type BrandGuidelines = BrandingData & {
  colors?: BrandingData['colors'] & { link?: string };
  typography?: BrandingData['typography'] & {
    fontStacks?: { body?: string[]; heading?: string[] };
  };
  components?: BrandingData['components'] & {
    input?: { borderColor?: string; borderRadius?: string };
  };
  designSystem?: { framework?: string; componentLibrary?: string };
  images?: { logo?: string; favicon?: string };
};

interface BrandExtractResponse {
  success: boolean;
  error?: string;
  url?: string;
  styleName?: string;
  guidelines?: BrandGuidelines;
}

/**
 * The denial a 402 attaches to its Error (`lib/import/client.ts`), taken from the
 * chat metadata that renders it so the two cannot drift apart.
 */
type CreditDenial = NonNullable<NonNullable<ChatMessage['metadata']>['creditDenial']>;

function AISandboxPage({
  githubConnected = false,
  githubRepoUrl = null,
  initialPhase = null,
  initialPlan = null,
}: {
  githubConnected?: boolean;
  githubRepoUrl?: string | null;
  initialPhase?: ProjectPhase | null;
  initialPlan?: WorkspacePlan | null;
}) {
  const generation = useGeneration();
  const {
    sandboxData,
    messages: chatMessages,
    setChatMessages,
    addChatMessage,
    generationProgress,
    setGenerationProgress,
    projectId,
    setProjectId,
    codeApplicationState,
    setCodeApplicationState,
    lastGeneratedCode,
    isJobActive,
    startGeneration: startGenerationStream,
    startApply,
    attachToProject,
    clear: clearGeneration,
    markError,
    markReady,
    status: generationJobStatus,
  } = generation;
  const [loading, setLoading] = useState(false);
  const [, setStatus] = useState({ text: 'Not connected', active: false });
  const [structureContent] = useState('No sandbox created yet');
  const [promptInput, setPromptInput] = useState('');
  const [aiChatInput, setAiChatInput] = useState('');
  const [aiEnabled] = useState(true);
  const searchParams = useSearchParams();
  const routeParams = useParams();
  const router = useRouter();
  const projectIdFromPath = typeof routeParams?.id === 'string' ? routeParams.id : null;
  const reconnectedRef = useRef(false);
  const pendingChatPromptRef = useRef<string | null>(null);
  // Empty means "no explicit choice": the server then starts the provider
  // chain at the configured primary (Admin → Configuration / AI_PRIMARY_*).
  // Hardcoding appConfig.ai.defaultModel here silently overrode that setting
  // on every build, because an explicit model outranks the chain's primary.
  const [aiModel, setAiModel] = useState(() => {
    const modelParam = searchParams.get('model');
    return appConfig.ai.availableModels.includes(modelParam || '') ? modelParam! : '';
  });
  const [, setUrlInput] = useState('');
  const [, setUrlStatus] = useState<string[]>([]);
  const [showHomeScreen, setShowHomeScreen] = useState(true);
  const [, setHomeScreenFading] = useState(false);
  const [homeUrlInput, setHomeUrlInput] = useState('');
  const [homeContextInput, setHomeContextInput] = useState('');
  const [activeTab, setActiveTab] = useState<'generation' | WorkspaceView>('preview');
  const [selectedStyle, setSelectedStyle] = useState<string | null>(null);
  const [, setShowLoadingBackground] = useState(false);
  const [urlScreenshot, setUrlScreenshot] = useState<string | null>(null);
  const [isScreenshotLoaded, setIsScreenshotLoaded] = useState(false);
  const [isCapturingScreenshot, setIsCapturingScreenshot] = useState(false);
  const [screenshotError, setScreenshotError] = useState<string | null>(null);
  const [isPreparingDesign, setIsPreparingDesign] = useState(false);
  const [, setTargetUrl] = useState<string>('');
  const [loadingStage, setLoadingStage] = useState<'gathering' | 'planning' | 'generating' | null>(
    null,
  );
  const [isStartingNewGeneration, setIsStartingNewGeneration] = useState(false);
  const [sandboxFiles, setSandboxFiles] = useState<Record<string, string>>({});
  const [hasInitialSubmission, setHasInitialSubmission] = useState<boolean>(false);
  const [, setFileStructure] = useState<string>('');

  /**
   * True once the mount fetch below has been refused (403 for a member on a
   * teammate's project, or any 5xx). Read by `hasStoredSite` at send time so an
   * unreadable project counts as having a site instead of as an empty one — a
   * swallowed fetch failure used to be enough to make the model rewrite it.
   */
  const fileMapUnreadableRef = useRef(false);
  /** Which project the map in state belongs to, so a switch can clear it. */
  const loadedFilesProjectRef = useRef<string | null>(null);

  // The Code tab used to fill only after an apply in this browser session, so
  // reopening a finished project showed an empty tree. Load the persisted site
  // once on mount; later applies refresh it through fetchSandboxFiles.
  useEffect(() => {
    const id = projectId ?? projectIdFromPath;
    if (!id) return;
    // Switching projects in the sidebar navigates to /project/{id} — the same
    // route segment — so React keeps this component and its state. The sticky
    // setter below then refused to overwrite the previous project's map, which
    // made `hasExistingSite` answer "yes" for a brand-new project and sent its
    // very first message as an edit: the route pushes EDIT MODE ("DO NOT
    // regenerate App.jsx") at a project with no files and the first build comes
    // back half-done. Only clear on a real switch: projectId also goes
    // null -> id when a project is created mid-generation, and that stream's
    // files must survive.
    const previousId = loadedFilesProjectRef.current;
    loadedFilesProjectRef.current = id;
    if (previousId && previousId !== id) {
      setSandboxFiles({});
      setFileStructure('');
      setGenerationProgress((prev) => (prev.isGenerating ? prev : { ...prev, files: [] }));
    }
    fileMapUnreadableRef.current = false;
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`/api/projects/${encodeURIComponent(id)}/files`);
        if (!response.ok) {
          // Cannot see the files, so cannot claim there are none.
          fileMapUnreadableRef.current = true;
          return;
        }
        const data = await response.json();
        if (!data.success) {
          fileMapUnreadableRef.current = true;
          return;
        }
        if (!cancelled) {
          setSandboxFiles((current) =>
            Object.keys(current).length > 0 ? current : data.files || {},
          );
          setFileStructure((current) => current || data.structure || '');
          // The code tab's tree and viewer render from generationProgress.files
          // (the live-stream state) — seed it so a reopened project shows its
          // site instead of an empty explorer. A stream in flight wins.
          const entries = Object.entries((data.files || {}) as Record<string, string>);
          if (entries.length > 0) {
            setGenerationProgress((prev) => {
              if (prev.isGenerating || prev.files.length > 0) return prev;
              return {
                ...prev,
                files: entries.map(([path, content]) => ({
                  path,
                  content,
                  type: path.split('.').pop() || 'text',
                  completed: true,
                })),
              };
            });
          }
        }
      } catch {
        // The tab stays empty; the next apply refreshes it. The next send still
        // has to treat this project as built — see fileMapUnreadableRef.
        fileMapUnreadableRef.current = true;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, projectIdFromPath]);

  const [conversationContext, setConversationContext] = useState<{
    scrapedWebsites: Array<{ url: string; content: unknown; timestamp: Date }>;
    generatedComponents: Array<{ name: string; path: string; content: string }>;
    appliedCode: Array<{ files: string[]; timestamp: Date }>;
    currentProject: string;
    lastGeneratedCode?: string;
  }>({
    scrapedWebsites: [],
    generatedComponents: [],
    appliedCode: [],
    currentProject: '',
    lastGeneratedCode: undefined,
  });

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const chatMessagesRef = useRef<HTMLDivElement>(null);

  // Store flag to trigger generation after component mounts
  const [shouldAutoGenerate, setShouldAutoGenerate] = useState(false);
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const [importMode, setImportMode] = useState<ImportMode>(DEFAULT_IMPORT_MODE);
  const [projectTitle, setProjectTitle] = useState('Untitled project');
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'signin'>('idle');
  const [projectUpdatedAt, setProjectUpdatedAt] = useState<string | null>(null);
  const [selectedPage, setSelectedPage] = useState('/');
  const pendingRestoreCodeRef = useRef<string | null>(null);
  const sendModeRef = useRef<ChatMode>('build');

  // Clear old conversation data on component mount and restore the saved project
  useEffect(() => {
    let isMounted = true;

    const initializePage = async () => {
      // First check URL parameters (from home page navigation)
      const urlParam = searchParams.get('url');
      const templateParam = searchParams.get('template');
      const detailsParam = searchParams.get('details');

      // URL params only. These used to fall back to global sessionStorage keys
      // (`targetUrl`, `selectedStyle`, `selectedModel`, `additionalInstructions`) that no
      // project owned, so a leftover `targetUrl` from an earlier creation auto-started a paid
      // build here, on a project the user had merely opened, from someone else's URL. What a
      // freshly created project needs is either its own arm (below) or its own `ImportSource`
      // row, both of which name the project.
      const storedUrl = urlParam;
      const storedStyle = templateParam;

      const projectIdParam = projectIdFromPath || searchParams.get('project');
      const live = attachToProject(projectIdParam);
      const liveMatches =
        isJobActive && (projectIdParam ? live.projectId === projectIdParam : !storedUrl);

      if (liveMatches) {
        reconnectedRef.current = true;
        if (live.projectId) {
          setProjectId(live.projectId);
          router.replace(`/project/${live.projectId}`, { scroll: false });
        }
        setHasInitialSubmission(true);
        setShowHomeScreen(false);
        setHomeScreenFading(false);
        setActiveTab(live.status === 'generating' ? 'generation' : 'preview');
        if (live.sandboxData) {
          // eslint-disable-next-line react-hooks/immutability -- declared later in this component
          updateStatus('Sandbox active', true);
        }
        if (live.lastGeneratedCode) {
          setConversationContext((prev) => ({
            ...prev,
            lastGeneratedCode: live.lastGeneratedCode || undefined,
          }));
        }
        setLoading(false);
        return;
      }

      if (getGenerationState().messages.length === 0) {
        addChatMessage(
          'Welcome! Describe the site you want and I will build it — I can see every file in this project, so you can ask for changes to any of them.\n\nThe preview compiles in your browser as soon as the code lands, so there is nothing to install or start.',
          'system',
        );
      }

      if (projectIdParam) {
        setProjectId(projectIdParam);
        setHasInitialSubmission(true);
        setShowHomeScreen(false);
        setHomeScreenFading(false);
        try {
          const projectRes = await fetch(`/api/projects/${projectIdParam}`);
          if (projectRes.ok) {
            const { project } = await projectRes.json();
            const loadedTitle = projectDisplayName(project) || 'Untitled project';
            setProjectTitle(loadedTitle);
            if (project.updatedAt) setProjectUpdatedAt(project.updatedAt);
            setHomeContextInput(project.style || '');
            setSelectedStyle(project.style || null);
            if (project.model) setAiModel(project.model);
            if (project.lastCode) {
              pendingRestoreCodeRef.current = project.lastCode;
              setConversationContext((prev) => ({
                ...prev,
                lastGeneratedCode: project.lastCode,
              }));
            }
            if (project.importSource?.sourceUrl) {
              setSourceUrl(project.importSource.sourceUrl);
              setHomeUrlInput(project.importSource.sourceUrl);
              setImportMode(resolveImportMode(project.importSource.mode));
              if (!project.lastCode && !isJobActive) {
                setShouldAutoGenerate(true);
              }
            }
            // No "previous generation stopped" heuristic here. It read the stale
            // `generationStatus` column and pasted `progressMessage` after it, which
            // produced "Previous generation stopped: Generation complete!" on a run
            // that had finished — a row left active by a client that died before its
            // terminal PATCH. Interruptions are the job row's story, and RecoveryPanel
            // tells it from `Job.status` with a Keep/Retry/Start over choice.
            addChatMessage(`Opened saved project: ${loadedTitle}`, 'system');
          } else if (projectRes.status === 401) {
            router.push(`/?auth=login&next=/project/${projectIdParam}`);
            return;
          }
        } catch (error) {
          console.error('[generation] Failed to load project', error);
        }
        // Taken for this project id and no other, and taken exactly once — the arm ends in a
        // chat send that can start a build.
        const armedPrompt = takeProjectArm(projectIdParam);
        if (armedPrompt) {
          pendingChatPromptRef.current = armedPrompt;
        }
      }

      if (storedUrl) {
        // Arrived as `?url=` (with optional `?template=` / `?details=`): treat it as an
        // initial submission and start on it. The style-name lookup and the model/
        // instruction fallbacks that used to live here only ever read the global
        // sessionStorage keys, which are gone — a URL import created from the dashboard
        // carries its own `ImportSource` row instead, and is resumed from it above.
        setHasInitialSubmission(true);
        setHomeUrlInput(storedUrl);
        setSelectedStyle(storedStyle || 'modern');
        if (detailsParam) {
          setHomeContextInput(detailsParam);
        }

        // Skip the home screen and go directly to builder
        setShowHomeScreen(false);
        setHomeScreenFading(false);

        // Set flag to auto-trigger generation after component updates
        setShouldAutoGenerate(true);
      }

      // Trim this workspace's own remembered conversation. The store is keyed per
      // project (per user when nothing is saved yet), so this can no longer truncate
      // anyone else's context the way the old process-global clear did.
      try {
        await fetch('/api/conversation-state', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'clear-old', projectId: projectIdParam }),
        });
        console.log('[home] Cleared old conversation data on mount');
      } catch (error) {
        console.error('[ai-sandbox] Failed to clear old conversation:', error);
        if (isMounted) {
          addChatMessage('Failed to clear old conversation data.', 'error');
        }
      }

      if (!isMounted) return;

      // `shouldAutoGenerate` above is the only auto-start signal now. The `autoStart`
      // sessionStorage flag this block used to write was a second, global one: it outlived
      // the mount that set it and started a paid build on whatever project opened next.
      setLoading(false);
    };

    initializePage();

    return () => {
      isMounted = false;
    };
  }, []); // Run only on mount

  useEffect(() => {
    // Handle Escape key for home screen
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && showHomeScreen) {
        setHomeScreenFading(true);
        setTimeout(() => {
          setShowHomeScreen(false);
          setHomeScreenFading(false);
        }, 500);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showHomeScreen]);

  // Start capturing screenshot if URL is provided on mount (from home screen)
  useEffect(() => {
    if (!showHomeScreen && homeUrlInput && !urlScreenshot && !isCapturingScreenshot) {
      let screenshotUrl = homeUrlInput.trim();
      if (!screenshotUrl.match(/^https?:\/\//i)) {
        screenshotUrl = 'https://' + screenshotUrl;
      }
      // eslint-disable-next-line react-hooks/immutability -- declared later in this component
      captureUrlScreenshot(screenshotUrl);
    }
  }, [showHomeScreen, homeUrlInput]);

  // The `autoStart` sessionStorage trigger that used to live here is gone. It was a second
  // auto-start path next to `shouldAutoGenerate` below, keyed to nothing, and it read a flag
  // any earlier mount could have left behind — which is how a project the user only opened
  // started a build it never asked for.

  // Nothing to check on mount: there is no VM whose status could differ from
  // the project's stored files.

  useEffect(() => {
    if (chatMessagesRef.current) {
      chatMessagesRef.current.scrollTop = chatMessagesRef.current.scrollHeight;
    }
  }, [chatMessages]);

  // Auto-trigger generation when flag is set (from home page navigation)
  useEffect(() => {
    if (reconnectedRef.current || isJobActive) return;
    if (shouldAutoGenerate && homeUrlInput && !showHomeScreen) {
      // Reset the flag
      setShouldAutoGenerate(false);

      // Small delay so everything is set up. Clearing the handle on unmount is not cosmetic:
      // startGeneration spends credits and hands the work to the module-level runtime that
      // deliberately outlives this page, so a timer left armed after the person navigated
      // away started a paid generation nobody was watching.
      const timer = setTimeout(() => {
        console.log('[generation] Auto-triggering generation from URL params');
        // eslint-disable-next-line react-hooks/immutability -- declared later in this component
        startGeneration();
      }, 1000);

      return () => clearTimeout(timer);
    }
  }, [shouldAutoGenerate, homeUrlInput, showHomeScreen]);

  useEffect(() => {
    if (lastGeneratedCode) {
      setConversationContext((prev) =>
        prev.lastGeneratedCode === lastGeneratedCode ? prev : { ...prev, lastGeneratedCode },
      );
    }
  }, [lastGeneratedCode]);

  useEffect(() => {
    if (sandboxData?.url && iframeRef.current) {
      const currentSrc = iframeRef.current.src || '';
      if (!currentSrc.includes(sandboxData.url)) {
        iframeRef.current.src = sandboxData.url;
      }
    }
  }, [sandboxData?.url]);

  useEffect(() => {
    if (reconnectedRef.current && isJobActive) {
      setActiveTab(generationJobStatus === 'generating' ? 'generation' : 'preview');
    }
  }, [generationJobStatus, isJobActive]);

  /**
   * Code while it is being written, preview the moment it is finished.
   *
   * The Code tab is where the build is legible — the file rail, the body filling
   * in — but once the last file lands there is nothing left to watch there, and the
   * thing the person actually asked for is the site. Leaving them on a static file
   * list is what made a finished build feel like it had not finished.
   *
   * Only on the transition, and only from the code tab: someone who opened Quality
   * or Assets mid-build, or who is reading code deliberately after it ended, keeps
   * the view they chose.
   */
  const wasGeneratingRef = useRef(false);
  useEffect(() => {
    const generating = generationProgress.isGenerating;
    const finished = wasGeneratingRef.current && !generating;
    wasGeneratingRef.current = generating;
    if (!finished) return;
    if (generationProgress.files.length === 0) return;
    setActiveTab((current) => (current === 'generation' ? 'preview' : current));
  }, [generationProgress.isGenerating, generationProgress.files.length]);

  const updateStatus = (text: string, active: boolean) => {
    setStatus({ text, active });
  };

  const saveCurrentProject = async (overrides?: {
    sandboxId?: string;
    previewUrl?: string;
    prompt?: string;
  }) => {
    const prompt =
      overrides?.prompt ||
      homeUrlInput ||
      homeContextInput ||
      conversationContext.lastGeneratedCode?.slice(0, 80) ||
      'Untitled project';

    setSaveState('saving');
    try {
      const result = await persistProject({
        id: getGenerationState().projectId ?? projectId,
        title: projectTitle === 'Untitled project' ? prompt : projectTitle,
        prompt,
        style: selectedStyle || homeContextInput || null,
        model: aiModel,
        // No sandboxId. It was sent as `null` — present, not absent — so
        // persistProjectGeneration spread a column `Project` no longer has into
        // prisma.project.update, every PATCH answered 500, and the stream reader
        // below died on the first progress frame while the server kept generating.
        previewUrl: overrides?.previewUrl || sandboxData?.url || null,
        screenshot: urlScreenshot,
        // No lastCode: the server owns it. This sent the model's raw markdown
        // reply, which overwrote the normalised <file path=…> lastCode that
        // settleStreamedGeneration had written — getCurrentProjectFiles then
        // collapsed the whole chat answer into one bogus src/App.jsx and the
        // site was destroyed. lastGeneratedCode stays in state for prompt and
        // title text only.
        status: getGenerationState().status,
        progressMessage: getGenerationState().generationProgress.status || null,
        sourceMessage: [...getGenerationState().messages]
          .reverse()
          .find((entry) => entry.type === 'user' && entry.content.trim())?.content,
        source: [...getGenerationState().messages]
          .reverse()
          .find((entry) => entry.type === 'user' && entry.content.trim())?.metadata?.source,
      });

      if (!result.saved) {
        setSaveState('signin');
        return;
      }

      setProjectId(result.project.id);
      setProjectTitle(projectDisplayName(result.project) || 'Untitled project');
      if (result.project.updatedAt) setProjectUpdatedAt(result.project.updatedAt);
      else setProjectUpdatedAt(new Date().toISOString());
      setSaveState('saved');
      surfacePreviewNotice(result.previewNotice);
      router.replace(`/project/${result.project.id}`, { scroll: false });
    } catch (error) {
      console.error('[generation] Failed to save project', error);
      setSaveState('idle');
    }
  };

  const applyGeneratedCode = async (
    code: string,
    isEdit: boolean = false,
    overrideSandboxData?: SandboxData,
    buildFix?: BuildFixRequest | null,
  ) => {
    setLoading(true);

    try {
      // Show progress component instead of individual messages
      setCodeApplicationState({ stage: 'analyzing' });

      // Get pending packages from tool calls. The other side of this window
      // handshake is generation-runtime.ts, which writes it with the same shape.
      const packageHandshake = window as unknown as { pendingPackages?: string[] };
      const pendingPackages = (packageHandshake.pendingPackages || []).filter(
        (pkg) => pkg && typeof pkg === 'string',
      );
      if (pendingPackages.length > 0) {
        console.log('[applyGeneratedCode] Sending packages from tool calls:', pendingPackages);
        // Clear pending packages after use
        // Shared handshake with generation-runtime (window.pendingPackages).
        // eslint-disable-next-line react-hooks/immutability
        packageHandshake.pendingPackages = [];
      }

      // Stream is owned by GenerationProvider so leaving the workspace does not abort it
      const effectiveSandboxData = overrideSandboxData || sandboxData;
      await startApply({
        code,
        isEdit,
        packages: pendingPackages,
        sandboxId: effectiveSandboxData?.sandboxId,
      });

      // Close the build → fix → re-generate loop. The server decides whether a
      // retry is warranted (attempt cap, repeated-failure guard, actionability)
      // and only then returns buildFix; the client's job is to run it, not to
      // re-derive the policy. Absent buildFix means the loop is over.
      //
      // It arrives on the *generate* complete frame. This used to read it off
      // `applyResult.finalData`, which `runApplyStream` returns as null by
      // design — so the branch was unreachable and the loop never ran once.
      if (buildFix?.instruction) {
        addChatMessage(
          `Build failed — attempting an automatic fix (${buildFix.attempt}/2).`,
          'system',
        );
        try {
          const fixResult = await startGenerationStream({
            prompt: buildFix.instruction,
            model: aiModel,
            context: { sandboxId: effectiveSandboxData?.sandboxId, currentFiles: {} },
            isEdit: true,
            projectId: projectId ?? undefined,
            sandboxData: effectiveSandboxData ?? undefined,
            // Carried back so the server's cap and repeat guard can see this is
            // already a retry. Without them every attempt looked like the first.
            buildFixAttempt: buildFix.attempt,
            buildFixSignature: buildFix.signature,
          });
          if (fixResult?.generatedCode) {
            // Recurse with whatever the repair reply itself validated to; the
            // server stops the loop by withholding buildFix once the cap or the
            // guard trips.
            return await applyGeneratedCode(
              fixResult.generatedCode,
              true,
              overrideSandboxData,
              fixResult.buildFix,
            );
          }
          addChatMessage('The automatic build fix produced no changes.', 'system');
        } catch (fixError: unknown) {
          // A failed fix must not lose the original apply result.
          addChatMessage(
            `Automatic build fix failed: ${fixError instanceof Error ? fixError.message : String(fixError)}`,
            'system',
          );
        }
      }

      // A resolved startApply is success. Applying is no longer a stream: the
      // generate route already wrote the files and runApplyStream only marks
      // the job ready, so it resolves `{ finalData: null }` by design and a
      // real failure arrives as a rejection, handled below. The old
      // `finalData.type === 'complete'` branch could therefore never run, and
      // its else arm closed every successful build with "Code application may
      // have partially succeeded. Check the preview." — telling the user to
      // doubt a result that was fine, on every single turn.
      // Whichever shape the caller handed over: a generation reply is fenced
      // `{path=…}` output, a retried URL import is `<file path=…>` XML (F-054).
      const appliedFiles = appliedPathsFromReply(code);
      await fetchSandboxFiles();
      const applyCopy = applyPageCopy({ filesCreated: appliedFiles });
      const lastChat = getGenerationState().messages.at(-1)?.content;
      if (shouldAddApplyChat(lastChat, applyCopy.message)) {
        addChatMessage(
          applyCopy.message,
          'system',
          !isEdit && appliedFiles.length > 0 ? { appliedFiles } : undefined,
        );
      }
    } catch (error: unknown) {
      // An abort is the person's own Stop button, not a failure worth reporting.
      if (error instanceof Error && error.name === 'AbortError') return;
      // The only report this failure gets. It used to go to `log()`, which
      // appended to a state array nothing rendered, so a failed apply told the
      // user nothing at all (F-058).
      addChatMessage(`Failed to apply code: ${toMessage(error, 'Apply failed.')}`, 'system');
    } finally {
      setLoading(false);
      // Clear isEdit flag after applying code
      setGenerationProgress((prev) => ({
        ...prev,
        isEdit: false,
      }));
    }
  };

  const fetchSandboxFiles = async () => {
    const filesProjectId = getGenerationState().projectId ?? projectId ?? projectIdFromPath;
    // No early return on missing sandboxData: with a projectId the server can
    // serve the persisted site even when no live sandbox exists.
    if (!sandboxData && !filesProjectId) return;

    try {
      if (!filesProjectId) return;
      const response = await fetch(`/api/projects/${encodeURIComponent(filesProjectId)}/files`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (response.ok) {
        const data = await response.json();
        if (data.success) {
          setSandboxFiles(data.files || {});
          setFileStructure(data.structure || '');
          console.log(
            '[fetchSandboxFiles] Updated file list:',
            Object.keys(data.files || {}).length,
            'files',
          );
        }
      }
    } catch (error) {
      console.error('[fetchSandboxFiles] Error fetching files:', error);
    }
  };

  const renderMainContent = () => {
    // The Code view during a build. `isGenerating` alone is enough: a build that
    // has not produced a fence yet must still land on the panel, which says
    // "Code appears here as each file is written" instead of a bare spinner.
    if (
      activeTab === 'generation' &&
      (generationProgress.isGenerating || generationProgress.files.length > 0)
    ) {
      return <GenerationCodeView progress={generationProgress} />;
    } else if (activeTab === 'preview') {
      // Show loading state for initial generation or when starting a new generation with existing sandbox
      const isInitialGeneration =
        !sandboxData?.url &&
        (urlScreenshot || isCapturingScreenshot || isPreparingDesign || loadingStage);
      const isNewGenerationWithSandbox = isStartingNewGeneration && sandboxData?.url;
      const shouldShowLoadingOverlay =
        (isInitialGeneration || isNewGenerationWithSandbox) &&
        (loading ||
          generationProgress.isGenerating ||
          isPreparingDesign ||
          loadingStage ||
          isCapturingScreenshot ||
          isStartingNewGeneration);

      if (isInitialGeneration || isNewGenerationWithSandbox) {
        return (
          <div className="relative w-full h-full bg-gray-900">
            {/* Screenshot as background when available */}
            {urlScreenshot && (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img
                src={urlScreenshot}
                alt="Website preview"
                className="absolute inset-0 w-full h-full object-cover transition-opacity duration-700"
                style={{
                  opacity: isScreenshotLoaded ? 1 : 0,
                  willChange: 'opacity',
                }}
                onLoad={() => setIsScreenshotLoaded(true)}
                loading="eager"
              />
            )}

            {/* Loading overlay - only show when actively processing initial generation */}
            {shouldShowLoadingOverlay && (
              <div className="absolute inset-0 bg-black/70 flex flex-col items-center justify-center backdrop-blur-sm">
                {/* Loading animation with skeleton */}
                <div className="text-center max-w-md">
                  {/* Animated skeleton lines */}
                  <div className="mb-6 space-y-3">
                    <div
                      className="h-2 bg-gradient-to-r from-transparent via-white/20 to-transparent rounded animate-pulse"
                      style={{ animationDuration: '1.5s', animationDelay: '0s' }}
                    />
                    <div
                      className="h-2 bg-gradient-to-r from-transparent via-white/20 to-transparent rounded animate-pulse w-4/5 mx-auto"
                      style={{ animationDuration: '1.5s', animationDelay: '0.2s' }}
                    />
                    <div
                      className="h-2 bg-gradient-to-r from-transparent via-white/20 to-transparent rounded animate-pulse w-3/5 mx-auto"
                      style={{ animationDuration: '1.5s', animationDelay: '0.4s' }}
                    />
                  </div>

                  {/* Status text. `generationProgress.status` is derived from the same
                      fences the file rail is built from, so it names the file being
                      written ("Generating app/page.tsx") and only falls back to the
                      generic line before the first fence arrives. The literals here
                      used to override it, which is why a 30-second build showed one
                      unchanging sentence. */}
                  <p className="text-white text-lg font-medium">
                    {isCapturingScreenshot
                      ? 'Analyzing website...'
                      : isPreparingDesign
                        ? 'Preparing design...'
                        : generationProgress.isGenerating
                          ? generationProgress.status || 'Generating code...'
                          : 'Loading...'}
                  </p>

                  {/* Subtle progress hint */}
                  <p className="text-white/60 text-sm mt-2">
                    {isCapturingScreenshot
                      ? 'Taking a screenshot of the site'
                      : isPreparingDesign
                        ? 'Understanding the layout and structure'
                        : generationProgress.isGenerating
                          ? (streamingFilesLabel(generationProgress.files) ??
                            'Writing the first file')
                          : 'Please wait...'}
                  </p>
                </div>
              </div>
            )}
          </div>
        );
      }

      // Show sandbox iframe - keep showing during edits, only hide during initial loading
      if (sandboxData?.url) {
        return (
          <div className="relative w-full h-full">
            <iframe
              ref={iframeRef}
              src={sandboxData.url}
              className="w-full h-full border-none"
              title="Navroop Sandbox"
              allow="clipboard-write"
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
            />

            {/* Package installation overlay - shows when installing packages or applying code */}
            {codeApplicationState.stage && codeApplicationState.stage !== 'complete' && (
              <div className="absolute inset-0 bg-white/95 backdrop-blur-sm flex items-center justify-center z-10">
                <div className="text-center max-w-md">
                  <div className="mb-6">
                    {/* Animated icon based on stage */}
                    {codeApplicationState.stage === 'installing' ? (
                      <div className="w-16 h-16 mx-auto">
                        <svg className="w-full h-full animate-spin" fill="none" viewBox="0 0 24 24">
                          <circle
                            className="opacity-25"
                            cx="12"
                            cy="12"
                            r="10"
                            stroke="currentColor"
                            strokeWidth="4"
                          ></circle>
                          <path
                            className="opacity-75"
                            fill="currentColor"
                            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                          ></path>
                        </svg>
                      </div>
                    ) : null}
                  </div>

                  <h3 className="text-lg font-semibold text-gray-900 mb-2">
                    {codeApplicationState.stage === 'analyzing' && 'Analyzing code...'}
                    {codeApplicationState.stage === 'installing' && 'Installing packages...'}
                    {codeApplicationState.stage === 'applying' && 'Applying changes...'}
                  </h3>

                  {/* Package list during installation */}
                  {codeApplicationState.stage === 'installing' && codeApplicationState.packages && (
                    <div className="mb-4">
                      <div className="flex flex-wrap gap-2 justify-center">
                        {codeApplicationState.packages.map((pkg, index) => (
                          <span
                            key={index}
                            className={`px-2 py-1 text-xs rounded-full transition-all ${
                              codeApplicationState.installedPackages?.includes(pkg)
                                ? 'bg-green-100 text-green-700'
                                : 'bg-gray-100 text-gray-600'
                            }`}
                          >
                            {pkg}
                            {codeApplicationState.installedPackages?.includes(pkg) && (
                              <span className="ml-1">✓</span>
                            )}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Files being generated */}
                  {codeApplicationState.stage === 'applying' &&
                    codeApplicationState.filesGenerated && (
                      <div className="text-sm text-gray-600">
                        Creating {codeApplicationState.filesGenerated.length} files...
                      </div>
                    )}

                  <p className="text-sm text-gray-500 mt-2">
                    {codeApplicationState.stage === 'analyzing' &&
                      'Parsing generated code and detecting dependencies...'}
                    {codeApplicationState.stage === 'installing' &&
                      'This may take a moment while npm installs the required packages...'}
                    {codeApplicationState.stage === 'applying' &&
                      'Writing files to your sandbox environment...'}
                  </p>
                </div>
              </div>
            )}

            {/* Show a subtle indicator when code is being edited/generated */}
            {generationProgress.isGenerating &&
              generationProgress.isEdit &&
              !codeApplicationState.stage && (
                <div className="absolute top-4 right-4 inline-flex items-center gap-2 px-3 py-1.5 bg-black/80 backdrop-blur-sm rounded-lg">
                  <div className="w-2 h-2 bg-green-400 rounded-full animate-pulse" />
                  <span className="text-white text-xs font-medium">
                    {generationProgress.status || 'Generating code...'}
                  </span>
                </div>
              )}

            {/* Refresh button */}
            <button
              onClick={() => {
                if (iframeRef.current && sandboxData?.url) {
                  console.log('[Manual Refresh] Forcing iframe reload...');
                  const newSrc = `${sandboxData.url}?t=${Date.now()}&manual=true`;
                  iframeRef.current.src = newSrc;
                }
              }}
              className="absolute bottom-4 right-4 bg-white/90 hover:bg-white text-gray-700 p-2 rounded-lg shadow-lg transition-all duration-200 hover:scale-105"
              title="Refresh sandbox"
            >
              <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                />
              </svg>
            </button>
          </div>
        );
      }

      // Default state when no sandbox and no screenshot
      return (
        <div className="flex items-center justify-center h-full bg-gray-50 text-gray-600 text-lg">
          {screenshotError ? (
            <div className="text-center">
              <p className="mb-2">Failed to capture screenshot</p>
              <p className="text-sm text-gray-500">{screenshotError}</p>
            </div>
          ) : sandboxData ? (
            <div className="text-gray-500">
              <div className="w-16 h-16 border-2 border-gray-300 border-t-transparent rounded-full animate-spin mx-auto mb-2" />
              <p className="text-sm">Loading preview...</p>
            </div>
          ) : (
            <div className="text-gray-500 text-center">
              <p className="text-sm">Start chatting to create your first app</p>
            </div>
          )}
        </div>
      );
    }
    return null;
  };

  const sendChatMessage = async (
    override?: string,
    options?: { mode?: ChatMode; source?: MessageSource; silent?: boolean },
  ) => {
    const message = (typeof override === 'string' ? override : aiChatInput).trim();
    const mode = options?.mode || sendModeRef.current;
    if (options?.mode) sendModeRef.current = options.mode;
    if (!message) return;

    if (!aiEnabled) {
      addChatMessage('AI is disabled. Please enable it first.', 'system');
      return SEND_FAILED;
    }

    const source = options?.source && options.source !== 'chat' ? options.source : undefined;
    if (!options?.silent) {
      addChatMessage(message, 'user', source ? { source } : undefined);
    }
    setAiChatInput('');

    // Check for special commands
    const lowerMessage = message.toLowerCase().trim();
    if (
      lowerMessage === 'check packages' ||
      lowerMessage === 'install packages' ||
      lowerMessage === 'npm install'
    ) {
      addChatMessage(
        'There is nothing to install — the preview loads each dependency straight from the CDN when it compiles. Just ask for the package you want to use.',
        'system',
      );
      return;
    }

    if (shouldRequestFollowUpPlan(mode)) {
      const id = projectId || projectIdFromPath;
      if (!id) {
        addChatMessage('Project is not ready for planning yet.', 'system');
        return SEND_FAILED;
      }
      try {
        const response = await fetch(`/api/projects/${id}/plan/followup`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message }),
        });
        const data = await response.json().catch(() => null);
        if (!response.ok) {
          addChatMessage((data && data.error) || 'Could not start a plan.', 'system');
          return SEND_FAILED;
        }
        addChatMessage('Plan ready. Review and approve to apply these changes.', 'ai');
      } catch (error: unknown) {
        addChatMessage(`Error: ${toMessage(error, 'Could not start a plan.')}`, 'system');
        return SEND_FAILED;
      }
      return;
    }

    // Nothing to boot before generating: the files go to the database and the
    // preview compiles them here.

    // An edit whenever the project already has a site to change. Never derive
    // this from conversationContext.appliedCode again — see hasExistingSite.
    // The decision fails closed: a project this browser could not read, or one
    // the server already rendered as COMPLETE, is treated as having a site even
    // when every client-side input is empty.
    const isEdit = hasExistingSite({
      projectFiles: sandboxFiles,
      streamedFiles: generationProgress.files,
      appliedCode: conversationContext.appliedCode,
      storedSite: hasStoredSite({
        initialPhase,
        fileMapUnreadable: fileMapUnreadableRef.current,
      }),
    });

    try {
      // Generation tab is already active from scraping phase
      setGenerationProgress((prev) => ({
        ...prev, // Preserve all existing state
        isGenerating: true,
        status: 'Starting AI generation...',
        components: [],
        currentComponent: 0,
        streamedCode: '',
        isStreaming: false,
        isThinking: true,
        thinkingText: 'Analyzing your request...',
        thinkingDuration: undefined,
        currentFile: undefined,
        lastProcessedPosition: 0,
        // Add isEdit flag to generation progress
        isEdit: isEdit,
        // Keep existing files for edits - we'll mark edited ones differently
        files: prev.files,
      }));

      // Backend now manages file state - no need to fetch from frontend
      console.log('[chat] Using backend file cache for context');

      const fullContext = {
        sandboxId: null,
        structure: structureContent,
        recentMessages: chatMessages.slice(-20),
        conversationContext: conversationContext,
        currentCode: promptInput,
        sandboxUrl: undefined,
        sandboxCreating: false,
      };

      // Debug what we're sending
      console.log('[chat] Sending context to AI:');
      console.log('[chat] - sandboxId:', fullContext.sandboxId);
      console.log('[chat] - isEdit:', isEdit);

      const streamResult = await startGenerationStream({
        prompt: message,
        model: aiModel,
        styleHint: selectedStyle || homeContextInput,
        context: { ...fullContext, styleName: selectedStyle || homeContextInput, mode },
        isEdit,
        projectId,
        sandboxData,
      });

      // A build was already in flight, so the route answered `{ reused: true }` as
      // JSON and attached to it: this prompt never reached a model. Saying so — and
      // handing the text back through the returned outcome — is the fix for the path
      // that used to fall through `if (generatedCode)` in silence and then print
      // "Generation complete!" over a message that was never sent. The progress reset
      // lives in the runtime's own reuse branch, next to the `setJobStatus` that
      // stops this tab's heartbeat.
      const outcome = sendOutcomeForStream(streamResult);
      if (!outcome.accepted) {
        addChatMessage(SEND_REFUSED_ALREADY_RUNNING, 'system');
        return outcome;
      }
      if (streamResult.streamDropped) {
        // The connection dropped with no terminal frame. The runtime already put an
        // honest system line in chat and wrote no status — the build may still be
        // finishing server-side, so do not claim completion or apply anything; the job
        // poll takes over from here (F-036).
        setActiveTab('preview');
        return outcome;
      }
      const generatedCode = streamResult.generatedCode;
      const explanation = streamResult.explanation;

      if (generatedCode) {
        // The model's own words, when it wrote any, and nothing else: the closing
        // "what was applied" sentence belongs to `applyPageCopy` below, which is
        // what it exists for. This used to scan the reply with
        // /<file path="…">/ for a file list — the reply is fenced `{path=…}`
        // output, never `<file>` XML, so the list was always empty, the edit
        // branch was dead, and every turn closed with a bare "Code generated!"
        // immediately followed by a second, real closing line (F-053).
        if (explanation) {
          addChatMessage(explanation, 'ai', {
            ...(streamResult.skillNames?.length ? { skillNames: streamResult.skillNames } : {}),
          });
        }

        setPromptInput(generatedCode);

        // Applying writes the files to the project and the preview recompiles
        // from them, so there is nothing to boot or wait for first. This used
        // to be gated on live sandbox data, which is now always null — every
        // generation streamed in, printed its files, and was then dropped.
        await applyGeneratedCode(generatedCode, isEdit, undefined, streamResult.buildFix);
      }

      // Show completion status briefly then switch to preview
      setGenerationProgress((prev) => ({
        ...prev,
        isGenerating: false,
        isStreaming: false,
        status: 'Generation complete!',
        isEdit: prev.isEdit,
        // Clear thinking state on completion
        isThinking: false,
        thinkingText: undefined,
        thinkingDuration: undefined,
      }));

      setTimeout(() => {
        // Switch to preview but keep files for display
        setActiveTab('preview');
      }, 1000); // Reduced from 3000ms to 1000ms
    } catch (error: unknown) {
      // An abort is the person's own Stop button: the prompt did reach the model, so
      // it does not go back in the box. Everything else — a 402, a 409, a 503, an
      // offline browser — never sent it, and the returned refusal is what hands the
      // typed text back to the input (F-006).
      if (error instanceof Error && error.name === 'AbortError') return;
      const message = toMessage(error, 'Generation failed.');
      setChatMessages((prev) => prev.filter((msg) => msg.content !== 'Thinking...'));
      addChatMessage(`Error: ${message}`, 'system');
      markError(message);
      setActiveTab('preview');
      return SEND_FAILED;
    }
  };

  useEffect(() => {
    const pending = pendingChatPromptRef.current;
    if (!pending || !projectId) return;
    const action = decidePendingPromptAction({ phase: initialPhase, prompt: pending });
    pendingChatPromptRef.current = null;
    if (action.kind === 'none') return;
    const timer = setTimeout(() => {
      if (action.kind === 'show') {
        addChatMessage(action.text, 'user');
        return;
      }
      void sendChatMessage(action.text);
    }, 400);
    return () => clearTimeout(timer);
  }, [initialPhase, projectId]);

  const captureUrlScreenshot = async (url: string) => {
    setIsCapturingScreenshot(true);
    setScreenshotError(null);
    try {
      const response = await fetch('/api/scrape-screenshot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });

      // `.catch(() => null)`, and the status read before the body: an error page
      // that is not JSON used to throw here and land in the catch below, which
      // told the user the network had failed while the server was the thing that
      // broke (F-057).
      const data = await response.json().catch(() => null);
      if (response.ok && data?.success && data.screenshot) {
        setIsScreenshotLoaded(false); // Reset loaded state for new screenshot
        setUrlScreenshot(data.screenshot);
        // Set preparing design state
        setIsPreparingDesign(true);
        // Store the clean URL for display
        const cleanUrl = url.replace(/^https?:\/\//i, '');
        setTargetUrl(cleanUrl);
        // Switch to preview tab to show the screenshot
        if (activeTab !== 'preview') {
          setActiveTab('preview');
        }
      } else {
        setScreenshotError(screenshotErrorMessage({ status: response.status, body: data }));
      }
    } catch (error) {
      console.error('Failed to capture screenshot:', error);
      // Only a request that never completed. Everything the server answered is
      // classified above, by its status.
      setScreenshotError(screenshotErrorMessage({ status: null, body: null }));
    } finally {
      setIsCapturingScreenshot(false);
    }
  };

  /**
   * `sourceUrlOverride` exists because a caller that has just called
   * `setHomeUrlInput` cannot see it: React has not committed the state yet, so
   * `homeUrlInput` here would still be the previous render's value. The sidebar
   * scrape panel does exactly that, and the guard below silently returned instead
   * of starting the clone the person asked for.
   */
  const startGeneration = async (sourceUrlOverride?: string) => {
    const cloneUrl = (sourceUrlOverride ?? homeUrlInput).trim();
    if (!cloneUrl) return;
    if (
      isJobActive &&
      generation.projectId &&
      generation.projectId === projectId &&
      generationProgress.isGenerating
    ) {
      return;
    }

    clearGeneration();

    setHomeScreenFading(true);

    // Set immediate loading state for better UX
    setIsStartingNewGeneration(true);
    setLoadingStage('gathering');

    // Immediately switch to preview tab to show loading
    setActiveTab('preview');

    // Set loading background to ensure proper visual feedback
    setShowLoadingBackground(true);

    // Clear messages and immediately show the initial message
    setChatMessages([]);
    let displayUrl = cloneUrl;
    if (!displayUrl.match(/^https?:\/\//i)) {
      displayUrl = 'https://' + displayUrl;
    }
    // Remove protocol for cleaner display
    const cleanUrl = displayUrl.replace(/^https?:\/\//i, '');

    // Check if we're in brand extension mode
    const brandExtensionMode = sessionStorage.getItem('brandExtensionMode') === 'true';

    addChatMessage(
      brandExtensionMode
        ? `Analyzing brand from ${cleanUrl}...`
        : `Starting to clone ${cleanUrl}...`,
      'system',
    );

    const sandboxPromise = Promise.resolve(null);

    // Set loading stage immediately before hiding home screen
    setLoadingStage('gathering');
    // Also ensure we're on preview tab to show the loading overlay
    setActiveTab('preview');

    // Always capture screenshot for new URLs, even if sandbox exists
    // This ensures the loading screen shows properly
    captureUrlScreenshot(displayUrl);

    setTimeout(async () => {
      setShowHomeScreen(false);
      setHomeScreenFading(false);

      // Clear the starting flag after transition
      setTimeout(() => {
        setIsStartingNewGeneration(false);
      }, 1000);

      // Wait for sandbox to be ready (if it's still creating)
      const createdSandbox = await sandboxPromise;

      // Now start the clone process which will stream the generation
      setUrlInput(cloneUrl);
      setUrlStatus(['Scraping website content...']);

      try {
        // Scrape the website
        let url = cloneUrl;
        if (!url.match(/^https?:\/\//i)) {
          url = 'https://' + url;
        }

        // Check if we're in brand extension mode
        const brandExtensionMode = sessionStorage.getItem('brandExtensionMode') === 'true';
        const brandExtensionPrompt = sessionStorage.getItem('brandExtensionPrompt') || '';

        // Screenshot is already being captured in parallel above

        let scrapeData: ScrapeData | undefined;
        let brandGuidelines: BrandExtractResponse | undefined;
        let importedCode: string | undefined;

        if (brandExtensionMode) {
          // === BRAND EXTENSION MODE ===
          addChatMessage('Extracting brand styles from the website...', 'system');

          // Call the brand extraction endpoint
          const extractResponse = await fetch('/api/extract-brand-styles', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              url,
              prompt: brandExtensionPrompt,
            }),
          });

          if (!extractResponse.ok) {
            throw new Error('Failed to extract brand styles');
          }

          const extracted: BrandExtractResponse = await extractResponse.json();
          brandGuidelines = extracted;

          if (!extracted.success) {
            throw new Error(extracted.error || 'Failed to extract brand styles');
          }

          // Display branding summary with visual UI
          addChatMessage(`Acquired branding format from ${cleanUrl}`, 'system', {
            brandingData: extracted.guidelines,
            sourceUrl: cleanUrl,
          });
          addChatMessage(
            `Building your custom component using these brand guidelines...`,
            'system',
          );

          // Clear the flags after use
          sessionStorage.removeItem('brandExtensionMode');
          sessionStorage.removeItem('brandExtensionPrompt');
        } else {
          let id = projectId || projectIdFromPath;
          if (!id) {
            await saveCurrentProject({ prompt: url });
            id = getGenerationState().projectId ?? projectId;
          }
          if (!id) {
            throw new Error('Could not create project for URL import');
          }
          const imported = await streamProjectImport({
            projectId: id,
            sourceUrl: url,
            // From this project's `ImportSource` row (read on mount), not from a global
            // `navroopImportMode` key that the previous import in this tab could have left.
            mode: resolveImportMode(importMode),
            onProgress: (message) => addChatMessage(message, 'system'),
          });
          imported.warnings.forEach((warning) => addChatMessage(warning, 'system'));
          setSourceUrl(imported.sourceUrl);
          importedCode = imported.filesXml;
          scrapeData = {
            success: true,
            url: imported.sourceUrl,
            content: imported.usedFallback ? 'fallback' : 'multi-pass',
          };
        }

        setUrlStatus(
          brandExtensionMode
            ? ['Brand styles extracted!', 'Building your component...']
            : ['Website scraped successfully!', 'Generating React app...'],
        );

        // Clear preparing design state and switch to generation tab
        setIsPreparingDesign(false);
        setIsScreenshotLoaded(false); // Reset loaded state
        setUrlScreenshot(null); // Clear screenshot when starting generation
        setTargetUrl(''); // Clear target URL

        // Update loading stage to planning
        setLoadingStage('planning');

        // Brief pause before switching to generation tab
        setTimeout(() => {
          setLoadingStage('generating');
          setActiveTab('generation');
        }, 1500);

        // Build the appropriate prompt based on mode
        let prompt;

        if (brandExtensionMode && brandGuidelines) {
          // === BRAND EXTENSION PROMPT ===
          // Store brand guidelines in conversation context
          setConversationContext((prev) => ({
            ...prev,
            scrapedWebsites: [
              ...prev.scrapedWebsites,
              {
                url: url,
                content: { brandGuidelines },
                timestamp: new Date(),
              },
            ],
            currentProject: `Custom build using ${url} brand`,
          }));

          // Extract comprehensive brand data. Defaulted because the endpoint can
          // answer `success: true` with no guidelines object at all.
          const branding: BrandGuidelines = brandGuidelines.guidelines ?? {};

          // Build detailed brand instruction string
          const brandInstructions = `
BRAND GUIDELINES FROM ${url}:

COLOR SYSTEM:
- Color Scheme: ${branding.colorScheme || 'light'} mode
- Primary Color: ${branding.colors?.primary || 'not specified'}
- Accent Color: ${branding.colors?.accent || 'not specified'}
- Background: ${branding.colors?.background || 'not specified'}
- Text Primary: ${branding.colors?.textPrimary || 'not specified'}
- Link Color: ${branding.colors?.link || 'not specified'}

TYPOGRAPHY:
- Primary Font: ${branding.typography?.fontFamilies?.primary || 'system default'}
- Heading Font: ${branding.typography?.fontFamilies?.heading || 'system default'}
- Font Stack (Body): ${branding.typography?.fontStacks?.body?.join(', ') || 'system-ui, sans-serif'}
- Font Stack (Heading): ${branding.typography?.fontStacks?.heading?.join(', ') || 'system-ui, sans-serif'}
- H1 Size: ${branding.typography?.fontSizes?.h1 || '36px'}
- H2 Size: ${branding.typography?.fontSizes?.h2 || '30px'}
- Body Size: ${branding.typography?.fontSizes?.body || '16px'}

SPACING & LAYOUT:
- Base Spacing Unit: ${branding.spacing?.baseUnit || '4'}px
- Border Radius: ${branding.spacing?.borderRadius || '6px'}

BUTTON STYLES:
Primary Button:
  - Background: ${branding.components?.buttonPrimary?.background || branding.colors?.primary}
  - Text Color: ${branding.components?.buttonPrimary?.textColor || '#FFFFFF'}
  - Border Radius: ${branding.components?.buttonPrimary?.borderRadius || branding.spacing?.borderRadius || '8px'}
  - Shadow: ${branding.components?.buttonPrimary?.shadow || 'none'}

Secondary Button:
  - Background: ${branding.components?.buttonSecondary?.background || '#F9F9F9'}
  - Text Color: ${branding.components?.buttonSecondary?.textColor || branding.colors?.textPrimary}
  - Border Radius: ${branding.components?.buttonSecondary?.borderRadius || branding.spacing?.borderRadius || '8px'}
  - Shadow: ${branding.components?.buttonSecondary?.shadow || 'none'}

INPUT FIELDS:
- Border Color: ${branding.components?.input?.borderColor || '#CCCCCC'}
- Border Radius: ${branding.components?.input?.borderRadius || branding.spacing?.borderRadius || '6px'}

BRAND PERSONALITY:
- Tone: ${branding.personality?.tone || 'professional'}
- Energy: ${branding.personality?.energy || 'medium'}
- Target Audience: ${branding.personality?.targetAudience || 'general'}

DESIGN SYSTEM:
- Framework: ${branding.designSystem?.framework || 'tailwind'}
- Component Library: ${branding.designSystem?.componentLibrary || 'custom'}

ASSETS:
${branding.images?.logo ? `- Logo Available: Yes (use carefully if needed)` : '- Logo: Not available'}
${branding.images?.favicon ? `- Favicon: ${branding.images.favicon}` : ''}`;

          // Deliberately says nothing about React, filenames or CSS policy: the server's
          // `buildStablePromptPrefix` already states the file shape for this project's real
          // stack, and this message contradicting it is what F-099 was. Note this branch is
          // currently unreachable from the product — nothing writes `brandExtensionMode` — so
          // whether it and `/api/extract-brand-styles` should exist at all is the F-448
          // unreachable-surface decision, not this row's.
          prompt = `I want you to build something NEW based on these brand guidelines and the user's requirements.

<branding-format source="${url}">
${brandInstructions}

RAW BRAND DATA (for reference):
${JSON.stringify(branding, null, 2)}
</branding-format>

USER'S REQUEST:
${brandExtensionPrompt || 'Build a modern web component using these brand guidelines'}

IMPORTANT: The content above in the <branding-format> tags contains the extracted brand guidelines from ${url}.
Use these guidelines (colors, fonts, spacing, design patterns) to build what the user requested.

CRITICAL REQUIREMENTS:
- DO NOT recreate the original website at ${url}
- DO create a COMPLETELY NEW component that fulfills the user's request
- The user wants: "${brandExtensionPrompt}"
- Build ONLY what the user requested - nothing more
- The root component should render ONLY the requested component - no extra Header/Footer/Hero unless specifically requested
- Make it a minimal, focused implementation of the user's request

STYLING REQUIREMENTS:
- Apply the EXACT colors from the brand palette (primary, accent, background, text colors)
- Use the EXACT typography (font families, font sizes for h1, h2, body)
- Apply the spacing system (base unit: ${branding.spacing?.baseUnit || '4'}px)
- Use the specified border radius (${branding.spacing?.borderRadius || '6px'}) consistently
- Implement button styles EXACTLY as specified (colors, shadows, border radius)
- Style input fields with the exact border color and border radius
- Match the brand's ${branding.colorScheme || 'light'} color scheme
- Apply the brand personality: ${branding.personality?.tone || 'professional'} tone with ${branding.personality?.energy || 'medium'} energy
- Use the brand palette values exactly, through the styling system the rules above specify
- If fonts need importing, add the @import or @font-face rule to the project's stylesheet

FONT SETUP:
${
  branding.typography?.fontFamilies?.primary
    ? `
- Add font family "${branding.typography.fontFamilies.primary}" to your CSS
- Use font stack: ${branding.typography?.fontStacks?.body?.join(', ') || 'system-ui, sans-serif'}
- Set body font size to ${branding.typography?.fontSizes?.body || '16px'}`
    : '- Use system fonts'
}

COMPONENT STRUCTURE:
- Use the file layout the stack rules above give. Do not invent a different one.
- The root component renders ONLY the requested component (e.g. just <PricingPage /> if the user wants pricing).
- One component file per thing the user asked for, plus the project's stylesheet for brand fonts and any effect the styling system cannot express.

TECHNICAL REQUIREMENTS:
- Create a WORKING, self-contained application
- DO NOT import components that don't exist
- Make sure the app renders immediately with visible content
- All colors must match the brand palette EXACTLY
- All spacing must use the ${branding.spacing?.baseUnit || '4'}px base unit
- Buttons must have the exact styling specified in the guidelines

Focus on building something NEW, minimal, and functional that perfectly matches the ${brandGuidelines.styleName || 'brand'} aesthetic and design system.`;
        } else {
          // === NORMAL CLONE MODE PROMPT ===
          // Store scraped data in conversation context
          if (!scrapeData) {
            throw new Error('Scrape data is missing');
          }
          setConversationContext((prev) => ({
            ...prev,
            scrapedWebsites: [
              ...prev.scrapedWebsites,
              {
                url: url,
                content: scrapeData,
                timestamp: new Date(),
              },
            ],
            currentProject: `${url} Clone`,
          }));

          // Filter out style-related context when using screenshot/URL-based generation
          // Only keep user's explicit instructions, not inherited styles
          let filteredContext = homeContextInput;
          if (cloneUrl && homeContextInput) {
            // Check if the context contains default style names that shouldn't be inherited
            const stylePatterns = [
              'Glassmorphism style design',
              'Neumorphism style design',
              'Brutalism style design',
              'Minimalist style design',
              'Dark Mode style design',
              'Gradient Rich style design',
              '3D Depth style design',
              'Retro Wave style design',
              'Modern clean and minimalist style design',
              'Fun colorful and playful style design',
              'Corporate professional and sleek style design',
              'Creative artistic and unique style design',
            ];

            // If the context exactly matches or starts with a style pattern, filter it out
            const startsWithStyle = stylePatterns.some((pattern) =>
              homeContextInput.trim().startsWith(pattern),
            );

            if (startsWithStyle) {
              // Extract only the additional instructions part after the style
              const additionalMatch = homeContextInput.match(/\. (.+)$/);
              filteredContext = additionalMatch ? additionalMatch[1] : '';
            }
          }

          // No stack, no filenames, no styling policy in here. The server assembles the
          // system prompt for *this project's* stack (`buildStablePromptPrefix`: BASE_RULES +
          // SEO rules + the per-stack file shape), so this message only has to describe the
          // job. It used to say "a complete React application", name `src/App.jsx` and
          // `src/index.css`, and tell the model to write custom CSS classes — which is the
          // opposite of BASE_RULES' Tailwind-only rule, and which handed a NEXTJS or
          // STATIC_HTML project instructions for a stack it is not, so `stackShapeMismatch`
          // failed the build at settle time (F-099).
          prompt = `I want to recreate the ${url} website based on the scraped content below.

${JSON.stringify(scrapeData, null, 2)}

${
  filteredContext
    ? `ADDITIONAL CONTEXT/REQUIREMENTS FROM USER:
${filteredContext}

Please incorporate these requirements into the design and implementation.`
    : ''
}

IMPORTANT INSTRUCTIONS:
- Implement ALL sections and features from the original site
- Make it responsive and modern
- Ensure all text content matches the original
- Create ALL components that you reference in imports
${filteredContext ? "- Apply the user's context/theme requirements throughout the application" : ''}

Focus on the key sections and content, making it clean and modern. Follow the stack, file layout and styling rules given above — do not invent a different project shape.`;
        }

        const activeSandbox = createdSandbox || getGenerationState().sandboxData;
        let generatedCode = importedCode || '';
        let explanation = '';
        if (!importedCode) {
          const streamResult = await startGenerationStream({
            prompt,
            model: aiModel,
            styleHint: selectedStyle || homeContextInput,
            context: {
              sandboxId: activeSandbox?.sandboxId,
              structure: structureContent,
              conversationContext: conversationContext,
              styleName: selectedStyle || homeContextInput,
            },
            sandboxData: activeSandbox,
          });
          generatedCode = streamResult.generatedCode;
          explanation = streamResult.explanation;
        }

        if (generatedCode) {
          addChatMessage('AI recreation generated!', 'system');

          // Add the explanation to chat if available
          if (explanation && explanation.trim()) {
            addChatMessage(explanation, 'ai');
          }

          setPromptInput(generatedCode);

          // Apply the code (first time is not edit mode)
          await applyGeneratedCode(generatedCode, false, activeSandbox || undefined);

          addChatMessage(
            brandExtensionMode
              ? `Successfully built your custom component using ${cleanUrl}'s brand guidelines! You can now ask me to modify it or add more features.`
              : `Successfully recreated ${url} as a modern React app${homeContextInput ? ` with your requested context: "${homeContextInput}"` : ''}! The scraped content is now in my context, so you can ask me to modify specific sections or add features based on the original site.`,
            'ai',
            {
              scrapedUrl: url,
              scrapedContent: brandExtensionMode ? { brandGuidelines } : scrapeData,
              generatedCode: generatedCode,
            },
          );

          setConversationContext((prev) => ({
            ...prev,
            generatedComponents: [],
            appliedCode: [
              ...prev.appliedCode,
              {
                files: [],
                timestamp: new Date(),
              },
            ],
          }));
        } else {
          throw new Error('Failed to generate recreation');
        }

        setUrlInput('');
        setUrlStatus([]);
        setHomeContextInput('');

        markReady();

        // Clear screenshot and preparing design states to prevent them from showing on next run
        setIsScreenshotLoaded(false); // Reset loaded state
        setUrlScreenshot(null);
        setIsPreparingDesign(false);
        setTargetUrl('');
        setScreenshotError(null);
        setLoadingStage(null); // Clear loading stage
        setIsStartingNewGeneration(false); // Clear new generation flag
        setShowLoadingBackground(false); // Clear loading background

        setTimeout(() => {
          // Switch back to preview tab but keep files
          setActiveTab('preview');
        }, 1000); // Show completion briefly then switch
      } catch (error: unknown) {
        // An abort is the person's own Stop button, not a failure to report.
        if (error instanceof Error && error.name === 'AbortError') return;
        // A 402 arrives as an Error carrying its denial, which is what renders the
        // credit panel in chat instead of a bare error line.
        const denial = (error as { creditDenial?: CreditDenial } | null)?.creditDenial;
        const message = toMessage(error, 'Import failed');
        if (denial) {
          addChatMessage(denial.message, 'error', { creditDenial: denial });
        } else {
          addChatMessage(message, 'error');
        }
        setUrlStatus([]);
        setIsPreparingDesign(false);
        setIsStartingNewGeneration(false); // Clear new generation flag on error
        setLoadingStage(null);
        markError(message);
      }
    }, 500);
  };

  const workspacePages = useMemo(() => {
    const fromSandbox = Object.keys(sandboxFiles);
    const fromProgress = generationProgress.files.map((file) => file.path);
    return pagesFromFiles([...fromSandbox, ...fromProgress]);
  }, [sandboxFiles, generationProgress.files]);

  const workspaceView: WorkspaceView = activeTab === 'generation' ? 'code' : activeTab;

  const refreshPreview = () => {
    if (!iframeRef.current || !sandboxData?.url) return;
    const base = sandboxData.url.replace(/\/$/, '');
    const path = selectedPage === '/' ? '' : selectedPage;
    iframeRef.current.src = `${base}${path}?t=${Date.now()}`;
  };

  const renameProject = async (nextTitle: string) => {
    setProjectTitle(nextTitle);
    const id = projectId || projectIdFromPath;
    if (!id) return;
    setSaveState('saving');
    try {
      const response = await fetch(`/api/projects/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        // The API's update schema takes `name`. This sent `title`, which the
        // schema rejected — every rename from the top bar silently no-opped.
        body: JSON.stringify({ name: nextTitle }),
      });
      if (!response.ok) {
        setSaveState('idle');
        return;
      }
      const data = await response.json().catch(() => null);
      if (data?.project?.updatedAt) setProjectUpdatedAt(data.project.updatedAt);
      else setProjectUpdatedAt(new Date().toISOString());
      setSaveState('saved');
    } catch {
      setSaveState('idle');
    }
  };

  return (
    <ProjectWorkspace
      projectId={projectId || projectIdFromPath}
      projectName={projectTitle}
      saveState={saveState}
      updatedAt={projectUpdatedAt}
      onRename={renameProject}
      messages={chatMessages}
      // Returned, not voided: the resolved outcome is how ChatInput learns a send
      // was refused and puts the typed text back.
      onSend={(text, options) => sendChatMessage(text, options)}
      sending={isJobActive || generationProgress.isGenerating || loading}
      pages={workspacePages}
      selectedPage={selectedPage}
      onSelectPage={(path) => {
        setSelectedPage(path);
        if (iframeRef.current && sandboxData?.url) {
          const base = sandboxData.url.replace(/\/$/, '');
          iframeRef.current.src = path === '/' ? sandboxData.url : `${base}${path}`;
        }
      }}
      view={workspaceView}
      onViewChange={(next) => {
        if (next === 'code') setActiveTab('generation');
        else setActiveTab(next);
      }}
      onRefresh={refreshPreview}
      sandboxUrl={sandboxData?.url}
      chatHeader={
        <>
          {!hasInitialSubmission ? (
            <div className="border-b border-[var(--studio-line)] p-12">
              <SidebarInput
                onSubmit={(url, style, model, instructions) => {
                  // Straight into this page's state. These five values used to be written to
                  // global sessionStorage keys as well, which no project owned: the leftovers
                  // auto-started a paid build on the next project opened in this tab.
                  setHasInitialSubmission(true);
                  setHomeUrlInput(url);
                  setHomeContextInput(instructions || '');
                  setSelectedStyle(style);
                  setAiModel(model);
                  // Handed over explicitly: `setHomeUrlInput` above has not been
                  // committed yet, so reading the state here would see the previous
                  // render's empty string and the clone would never start.
                  void startGeneration(url);
                }}
                disabled={loading || generationProgress.isGenerating}
              />
            </div>
          ) : null}
          {codeApplicationState.stage ? (
            <div className="px-12 pt-8">
              <CodeApplicationProgress state={codeApplicationState} />
            </div>
          ) : null}
        </>
      }
      preview={renderMainContent()}
      githubConnected={githubConnected}
      githubRepoUrl={githubRepoUrl}
      sourceUrl={sourceUrl}
      importMode={importMode}
      initialPhase={initialPhase}
      initialPlan={initialPlan}
      isJobActive={isJobActive}
      streamFiles={generationProgress.files}
      streamedText={generationProgress.streamedCode}
      generationStatus={generationJobStatus}
      onStartApprovedBuild={(promptContext) => {
        void sendChatMessage(promptContext, { mode: 'build', silent: true });
      }}
      onRetryPlan={async (prompt) => {
        const id = projectId || projectIdFromPath;
        if (!id) {
          addChatMessage('Project is not ready.', 'system');
          return;
        }
        try {
          await retryProjectPlan({ projectId: id, prompt });
          addChatMessage('Plan ready. Review and approve to apply these changes.', 'ai');
        } catch (error) {
          addChatMessage(
            error instanceof Error ? error.message : 'Could not start a plan.',
            'system',
          );
        }
      }}
      onRetryImport={async ({ sourceUrl: retryUrl, mode }) => {
        const id = projectId || projectIdFromPath;
        if (!id) {
          addChatMessage('Project is not ready.', 'system');
          return;
        }
        try {
          const imported = await streamProjectImport({
            projectId: id,
            sourceUrl: retryUrl,
            mode,
            onProgress: (message) => addChatMessage(message, 'system'),
          });
          imported.warnings.forEach((warning) => addChatMessage(warning, 'system'));
          setSourceUrl(imported.sourceUrl);
          setImportMode(resolveImportMode(imported.mode));
          if (imported.filesXml) {
            await applyGeneratedCode(imported.filesXml, false);
          }
        } catch (error) {
          addChatMessage(error instanceof Error ? error.message : 'Import failed', 'system');
        }
      }}
      onThreadMessage={(content, type) => {
        addChatMessage(content, type);
      }}
    />
  );
}

export default function GenerationWorkspace({
  githubConnected = false,
  githubRepoUrl = null,
  initialPhase = null,
  initialPlan = null,
}: {
  githubConnected?: boolean;
  githubRepoUrl?: string | null;
  initialPhase?: ProjectPhase | null;
  initialPlan?: WorkspacePlan | null;
}) {
  return (
    <Suspense
      fallback={<div className="flex items-center justify-center min-h-screen">Loading...</div>}
    >
      <AISandboxPage
        githubConnected={githubConnected}
        githubRepoUrl={githubRepoUrl}
        initialPhase={initialPhase}
        initialPlan={initialPlan}
      />
    </Suspense>
  );
}
