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
/**
 * appliedCode is a same-project fallback (URL import, the turn before files
 * land). /project/[id] keeps this component mounted across sidebar switches,
 * so leftover entries from the previous project must not mark a new empty
 * Approve as an edit.
 */
export function appliedCodeForSend<T>(input: {
  appliedCode: readonly T[];
  sourceProjectId: string | null | undefined;
  projectId: string | null | undefined;
}): readonly T[] {
  if (!input.projectId || !input.sourceProjectId || input.sourceProjectId !== input.projectId) {
    return [];
  }
  return input.appliedCode;
}

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

/**
 * Why a send was refused.
 *
 * `already-running`: the server attached to a build already in flight, so the
 * prompt never reached a model. `send-failed`: the request itself did not get
 * through — a 402, 409, 503, an offline browser, or a thrown handler. Both mean
 * the same thing to the input box: nothing was sent, so the text must come back.
 */
export type SendRefusalReason = 'already-running' | 'send-failed';

/**
 * What a send did.
 *
 * `onSend` stays assignable to a `void`-returning prop, so the callers that cannot
 * refuse (the preview repair button, the plan thread) need no change; only the
 * paths that genuinely refused resolve `accepted: false`.
 */
export type SendOutcome = { accepted: true } | { accepted: false; reason: SendRefusalReason };

/**
 * What the chat says when the server attached to a build already in flight.
 *
 * The old behaviour was silence followed by "Generation complete!": the bubble was
 * appended, the box cleared, and `if (generatedCode)` was false because the route
 * had answered `{ job, reused: true }` as JSON instead of streaming. The new prompt
 * was not recorded on the job either — `createOrReuseJob` writes `inputPrompt` on
 * insert only — so the request was unrecoverable.
 */
export const SEND_REFUSED_ALREADY_RUNNING =
  'A build is already running on this project, so your message was not sent. Your text is back in the box — send it again once the current build finishes.';

/**
 * A reused job means the server joined a build that was already running, so this
 * prompt never reached a model. That is a refusal, not a silent success.
 */
export function sendOutcomeForStream(result: { alreadyRunning?: boolean }): SendOutcome {
  return result.alreadyRunning
    ? { accepted: false, reason: 'already-running' }
    : { accepted: true };
}

/**
 * The outcome for a send that did not get through. Every failing exit of
 * `sendChatMessage` returns this rather than `undefined`: an exit that returns
 * nothing is indistinguishable from an accepted send, which is how a 402/409/503
 * or an offline browser used to swallow the typed prompt (F-006). The draft is
 * cleared on send, so the outcome is the only thing that can hand the text back.
 */
export const SEND_FAILED: SendOutcome = { accepted: false, reason: 'send-failed' };

/**
 * Whether a refused send's text goes back in the box.
 *
 * Only when the box is still empty. A refusal lands asynchronously, so by then the
 * person may have started typing something else, and pasting the old prompt over it
 * would lose more text than the refusal did.
 */
export function shouldRestoreRefusedText(outcome: SendOutcome | undefined, current: string) {
  return Boolean(outcome && !outcome.accepted && !current.trim());
}

/**
 * Hands the just-sent text back to the box when the send did not get through.
 *
 * `ChatInput.submit` clears the input and the persisted draft before the request
 * settles, so this is the only thing that can undo that. It lives here, apart from
 * the component, so the three F-006 paths — a resolved refusal, a rejected promise,
 * and a caller that cannot refuse at all — are testable without a DOM.
 */
export async function restoreTextIfNotSent(
  sent: void | Promise<SendOutcome | void>,
  text: string,
  setValue: (update: (current: string) => string) => void,
) {
  if (!sent) return;
  const outcome = await settleSend(sent);
  setValue((current) => (shouldRestoreRefusedText(outcome, current) ? text : current));
}

/**
 * The settled outcome of a send. A `void`-returning send yields `undefined`, and a
 * rejected promise is the same event as a refusal — nothing was sent — so it
 * normalises to `SEND_FAILED`. The send handler reports the error itself; this
 * only classifies it, for the two things that have to be handed back when a send
 * does not get through: the typed text and the attached images (F-006, F-091).
 */
export async function settleSend(sent: Promise<SendOutcome | void>) {
  try {
    return (await sent) ?? undefined;
  } catch {
    return SEND_FAILED;
  }
}

/**
 * Hands the images attached to a refused send back to the composer.
 *
 * They are already uploaded to the project, so losing the chips would leave the
 * user paying for assets the next message no longer mentions. Same "only if the
 * user has not moved on" rule as the text: a fresh attachment wins.
 */
export async function restoreAttachmentsIfNotSent<T>(
  sent: void | Promise<SendOutcome | void>,
  attachments: T[],
  setAttachments: (update: (current: T[]) => T[]) => void,
) {
  if (!sent || attachments.length === 0) return;
  const outcome = await settleSend(sent);
  if (outcome?.accepted !== false) return;
  setAttachments((current) => (current.length === 0 ? attachments : current));
}

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
