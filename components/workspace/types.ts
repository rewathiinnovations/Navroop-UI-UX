export type ChatMode = 'plan' | 'build';

/** One send-routing decision: plan mode requests a follow-up plan; anything else builds. */
export function shouldRequestFollowUpPlan(mode: ChatMode | string | undefined) {
  return mode === 'plan';
}

/**
 * The other send-routing decision: does this project already have a site, so
 * the next message is an edit rather than a fresh build?
 *
 * This used to be `conversationContext.appliedCode.length > 0` inside
 * GenerationWorkspace, but that list stopped growing when applying stopped
 * being a stream — startApply resolves `{ finalData: null }` by design, so the
 * branch that appended to it was dead and every follow-up reached
 * /api/generate-ai-code-stream with isEdit false. The route then printed
 * "FIRST GENERATION MODE", never loaded the project's existing files, and the
 * model rewrote the whole site instead of changing the one thing that was
 * asked for — the failure the route's own comment describes. So decide from
 * state that survives a reload: the project's stored file map, which the
 * workspace loads on mount and refreshes after every apply. The streamed file
 * list and the URL-import marker stay as fallbacks for the turn right after a
 * build, when the file fetch may not have landed yet.
 *
 * `storedSite` is what makes the answer fail CLOSED, and it is not optional.
 * The three client-side inputs can only ever *under*-report a site: the file
 * map arrives from a best-effort fetch that swallows its own failure, and
 * `GET /api/projects/[id]/files` answers 403 to every non-owner non-admin
 * while the workspace renders for any signed-in member. A member opening a
 * teammate's finished project therefore got an empty map every single time —
 * not a race — sent isEdit false, and had the model replace someone else's
 * site with a brand-new one. The same chain fired for the owner on any 5xx.
 * Only a successful, empty read proves a project has nothing to change;
 * anything we could not read counts as having a site. See `hasStoredSite`.
 *
 * `streamedFiles` now carries the file currently being written as a
 * `completed: false` entry, and a half-written block is not a site: a stream that
 * died just after the first `{path=…}` opener would otherwise send the retry as
 * an edit ("DO NOT regenerate App.jsx") at a project that still has nothing.
 */
export function hasExistingSite(input: {
  projectFiles: Record<string, string>;
  streamedFiles: readonly { path: string; completed?: boolean }[];
  appliedCode: readonly unknown[];
  /** Server-side evidence of stored code — see `hasStoredSite`. */
  storedSite: boolean;
}): boolean {
  return (
    input.storedSite ||
    Object.keys(input.projectFiles).length > 0 ||
    input.streamedFiles.some((file) => file.completed !== false) ||
    input.appliedCode.length > 0
  );
}

/**
 * The fail-closed half of `hasExistingSite`, exported separately so the
 * workspace's actual decision is testable without rendering a 2800-line
 * component.
 *
 * `initialPhase` is server-rendered by app/project/[id]/page.tsx and COMPLETE
 * means the project row has code (lastCode/checkpoint), which no failed client
 * fetch can take away. `fileMapUnreadable` is the other direction: the mount
 * fetch came back 403 (a member on a teammate's project) or 5xx, so this
 * browser has no idea what the project holds and must not claim it is empty.
 *
 * Deliberately NOT true while that fetch is merely *pending*: the commonest
 * path in the product is "type on the home page, project is created, generate
 * immediately", and calling that first build an edit sends the model EDIT MODE
 * ("DO NOT regenerate App.jsx") at a project with no files, which comes back
 * as a half-built site. Absence of an answer is not evidence; a refusal is.
 */
export function hasStoredSite(input: {
  initialPhase: ProjectPhase | null;
  fileMapUnreadable: boolean;
}): boolean {
  return input.initialPhase === 'COMPLETE' || input.fileMapUnreadable;
}

export type MessageSource = 'chat' | 'visual-edit' | 'comment';

export type SendMessageOptions = {
  mode: ChatMode;
  source?: MessageSource;
  /** Start generation without adding a user bubble (Approve & Build). */
  silent?: boolean;
};

export type ProjectPhase = 'PLANNING' | 'BUILDING' | 'COMPLETE';
export type PlanStatus = 'PENDING' | 'APPROVED' | 'SUPERSEDED';
export type PlanTrigger = 'initial' | 'followup';

export type WorkspacePlanContent = {
  summary: string;
  pages: { name: string; description: string }[];
  keyFeatures: string[];
};

export type WorkspacePlan = {
  id: string;
  version: number;
  status: PlanStatus;
  trigger: PlanTrigger;
  sourceMessage: string;
  /**
   * When the plan was drafted, so the chat can show the card where it happened.
   * Without it the card was always rendered after the message list, so every later
   * message appeared above it and an approved plan looked like the newest thing in
   * the conversation.
   */
  createdAt: string;
  content: WorkspacePlanContent;
};

export function parsePlanContent(value: unknown): WorkspacePlanContent | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.summary !== 'string' || !raw.summary.trim()) return null;
  if (!Array.isArray(raw.pages) || !Array.isArray(raw.keyFeatures)) return null;
  const pages = raw.pages.flatMap((page) => {
    if (!page || typeof page !== 'object') return [];
    const item = page as Record<string, unknown>;
    if (typeof item.name !== 'string' || typeof item.description !== 'string') return [];
    return [{ name: item.name, description: item.description }];
  });
  const keyFeatures = raw.keyFeatures.filter(
    (item): item is string => typeof item === 'string' && Boolean(item.trim()),
  );
  if (pages.length === 0 || keyFeatures.length === 0) return null;
  return { summary: raw.summary, pages, keyFeatures };
}

/** Accepts the Prisma `Date`, a serialised ISO string, or neither. */
function planTimestamp(value: unknown): string {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  }
  return new Date(0).toISOString();
}

/** Latest plan for the thread. SUPERSEDED rows are omitted (replaced in place). */
export function toWorkspacePlan(value: unknown): WorkspacePlan | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (raw.status === 'SUPERSEDED') return null;
  if (raw.status !== 'PENDING' && raw.status !== 'APPROVED') return null;
  if (typeof raw.id !== 'string') return null;
  const content = parsePlanContent(raw.content);
  if (!content) return null;
  return {
    id: raw.id,
    version: typeof raw.version === 'number' ? raw.version : 1,
    status: raw.status,
    trigger: raw.trigger === 'followup' ? 'followup' : 'initial',
    sourceMessage: typeof raw.sourceMessage === 'string' ? raw.sourceMessage : '',
    // The row carries a Date; JSON gives a string. Neither is guaranteed here, and
    // an unusable value must not hide the card, so it falls back to the epoch —
    // which places it before every message, i.e. where a first plan belongs.
    createdAt: planTimestamp(raw.createdAt),
    content,
  };
}

export function approvedBuildPrompt(plan: WorkspacePlan) {
  return `${plan.sourceMessage}\n\nApproved plan:\n${JSON.stringify(plan.content)}`;
}

export type VisualEditTool = 'select' | 'text' | 'instruct' | 'comment';

/** The primary Preview/Code switch in the top bar. */
export const WORKSPACE_PRIMARY_TABS = [
  { id: 'preview', label: 'Preview' },
  { id: 'code', label: 'Code' },
] as const;

/** Secondary views, behind the top bar's "More views" overflow. Append here. */
export const WORKSPACE_TOOL_TABS = [
  { id: 'seo', label: 'Quality' },
  { id: 'assets', label: 'Assets' },
  { id: 'brain', label: 'Brain' },
  { id: 'domains', label: 'Domains' },
] as const;

export const WORKSPACE_TABS = [...WORKSPACE_PRIMARY_TABS, ...WORKSPACE_TOOL_TABS] as const;

export type WorkspaceView = (typeof WORKSPACE_TABS)[number]['id'];

export type ViewportSize = 'desktop' | 'tablet' | 'mobile';

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'signin';

export type WorkspacePage = {
  path: string;
  label: string;
};

export type Checkpoint = {
  id: string;
  thumbnailUrl: string | null;
  label: string;
  createdAt: string;
  isBookmarked?: boolean;
  snapshotPruned?: boolean;
};

export type MessageFeedback = 'up' | 'down' | null;
