export type ChatMode = 'plan' | 'build';

/** One send-routing decision: plan mode requests a follow-up plan; anything else builds. */
export function shouldRequestFollowUpPlan(mode: ChatMode | string | undefined) {
  return mode === 'plan';
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
    content,
  };
}

export function approvedBuildPrompt(plan: WorkspacePlan) {
  return `${plan.sourceMessage}\n\nApproved plan:\n${JSON.stringify(plan.content)}`;
}

export type VisualEditTool = 'select' | 'text' | 'instruct' | 'comment';

/** Append new workspace tabs here so TopBar stays a single mapped row. */
export const WORKSPACE_TABS = [
  { id: 'preview', label: 'Preview' },
  { id: 'code', label: 'Code' },
  { id: 'seo', label: 'Quality' },
  { id: 'assets', label: 'Assets' },
  { id: 'brain', label: 'Brain' },
] as const;

export type WorkspaceView = (typeof WORKSPACE_TABS)[number]['id'];

export type ViewportSize = 'desktop' | 'mobile';

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
};

export type MessageFeedback = 'up' | 'down' | null;
