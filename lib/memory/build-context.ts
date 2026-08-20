import { estimateTokens, estimateTokensForLength } from '@/lib/generation/token-estimate';
import { prisma } from '@/lib/db';
import {
  MEMORY_CATEGORIES,
  MEMORY_SCOPES,
  MEMORY_TOKEN_BUDGET,
  type MemoryBlockResult,
  type MemoryCategory,
  type MemoryRecord,
  type MemoryScope,
} from './types';

const CATEGORY_ORDER = new Map(MEMORY_CATEGORIES.map((category, index) => [category, index]));

function byNewest(a: MemoryRecord, b: MemoryRecord) {
  const delta = b.createdAt.getTime() - a.createdAt.getTime();
  if (delta !== 0) return delta;
  return a.id.localeCompare(b.id);
}

function byCategoryThenNewest(a: MemoryRecord, b: MemoryRecord) {
  const cat = (CATEGORY_ORDER.get(a.category) ?? 99) - (CATEGORY_ORDER.get(b.category) ?? 99);
  if (cat !== 0) return cat;
  return byNewest(a, b);
}

/**
 * Content is stored as free text up to 500 characters, newlines and Markdown included, and
 * is rendered as a bullet under a generated heading inside the cacheable prefix. Left raw,
 * an entry could close the Brain block and open a section that reads as a system-level
 * instruction — reachable through an approved extracted entry whose text came from a chat
 * message. Rendering flattens each entry to exactly one bullet: whitespace collapsed to
 * single spaces so nothing can start a new line, and leading Markdown structure dropped so
 * the bullet cannot read as a heading, rule or fence.
 */
function memoryPromptLine(content: string) {
  return content
    .replace(/\s+/g, ' ')
    .replace(/^[#>*+\-`\s]+/, '')
    .trim();
}

/**
 * The lines one row contributes to its scope's section: a category heading the first time
 * that category appears, then the row itself if it renders to anything. Both the renderer
 * and the budget accounting go through here, so a row is always priced as exactly the text
 * it will produce.
 */
function rowLines(row: MemoryRecord, newCategory: boolean) {
  const lines: string[] = [];
  if (newCategory) lines.push(`#### ${row.category}`);
  const line = memoryPromptLine(row.content);
  if (line) lines.push(`- ${line}`);
  return lines;
}

function groupLines(entries: MemoryRecord[]) {
  const lines: string[] = [];
  let current: MemoryCategory | null = null;
  for (const row of [...entries].sort(byCategoryThenNewest)) {
    const newCategory = row.category !== current;
    if (newCategory) current = row.category;
    lines.push(...rowLines(row, newCategory));
  }
  return lines;
}

const BLOCK_HEADER = [
  '## Brain memory',
  'Durable preferences. Do not treat as one-off task instructions.',
];
const WORKSPACE_HEADER = ['', '### Workspace', 'Applies to every project.'];
const PROJECT_HEADER = ['', '### This project'];

/** What `parts.join('\n')` costs: every part plus the separator after it, less the last one. */
function joinedCost(parts: string[]) {
  let cost = 0;
  for (const part of parts) cost += part.length + 1;
  return cost;
}

const BLOCK_HEADER_COST = joinedCost(BLOCK_HEADER);
const WORKSPACE_HEADER_COST = joinedCost(WORKSPACE_HEADER);
const PROJECT_HEADER_COST = joinedCost(PROJECT_HEADER);

function formatBlock(workspace: MemoryRecord[], project: MemoryRecord[]) {
  if (workspace.length === 0 && project.length === 0) return '';
  const parts = [...BLOCK_HEADER];
  if (workspace.length > 0) parts.push(...WORKSPACE_HEADER, ...groupLines(workspace));
  if (project.length > 0) parts.push(...PROJECT_HEADER, ...groupLines(project));
  return parts.join('\n');
}

/**
 * The length `formatBlock` would return for these two scopes, from their group-line costs
 * alone. `estimateTokens` reads nothing but the length, so a candidate row can be priced
 * without rendering the accumulated selection again.
 */
function blockCost(
  workspaceRows: number,
  workspaceLines: number,
  projectRows: number,
  projectLines: number,
) {
  if (workspaceRows === 0 && projectRows === 0) return 0;
  let cost = BLOCK_HEADER_COST;
  if (workspaceRows > 0) cost += WORKSPACE_HEADER_COST + workspaceLines;
  if (projectRows > 0) cost += PROJECT_HEADER_COST + projectLines;
  return cost - 1;
}

/**
 * The project's own memory may not lose to the workspace's. Workspace rows used to be
 * packed first and a row that did not fit both set `truncated` and `break`-ed, which
 * skipped the project loop entirely — so a workspace whose global memory alone reached the
 * budget injected zero project memory for every project, forever.
 *
 * Now project memory gets first refusal on half the budget, workspace memory fills what is
 * left, and any project rows still waiting take whatever remains. A row that does not fit
 * is skipped rather than ending the pass, so one long row cannot hide every shorter row
 * behind it. Each scope that lost a row is named, so the Brain footer can point at the list
 * whose owner can actually act on it.
 */
const PROJECT_BUDGET_RESERVE = Math.floor(MEMORY_TOKEN_BUDGET / 2);

/**
 * A scope's accumulated selection plus everything needed to price the next candidate: the
 * ids already kept, the categories whose heading has been paid for, and the running cost of
 * the group lines. Re-rendering the whole block per candidate was O(n^2) in block length on
 * the generation hot path; each candidate now costs its own length.
 */
type Section = {
  kept: MemoryRecord[];
  keptIds: Set<string>;
  categories: Set<MemoryCategory>;
  linesCost: number;
};

function selectWithinBudget(active: MemoryRecord[]) {
  const candidateWorkspace = active.filter((row) => row.scope === 'WORKSPACE').sort(byNewest);
  const candidateProject = active.filter((row) => row.scope === 'PROJECT').sort(byNewest);
  const workspace: Section = { kept: [], keptIds: new Set(), categories: new Set(), linesCost: 0 };
  const project: Section = { kept: [], keptIds: new Set(), categories: new Set(), linesCost: 0 };

  const pack = (rows: MemoryRecord[], scope: MemoryScope, budget: number) => {
    const section = scope === 'PROJECT' ? project : workspace;
    for (const row of rows) {
      if (section.keptIds.has(row.id)) continue;
      const newCategory = !section.categories.has(row.category);
      const added = joinedCost(rowLines(row, newCategory));
      const projected =
        scope === 'PROJECT'
          ? blockCost(
              workspace.kept.length,
              workspace.linesCost,
              project.kept.length + 1,
              project.linesCost + added,
            )
          : blockCost(
              workspace.kept.length + 1,
              workspace.linesCost + added,
              project.kept.length,
              project.linesCost,
            );
      if (estimateTokensForLength(projected) > budget) continue;
      section.kept.push(row);
      section.keptIds.add(row.id);
      section.categories.add(row.category);
      section.linesCost += added;
    }
  };

  pack(candidateProject, 'PROJECT', PROJECT_BUDGET_RESERVE);
  pack(candidateWorkspace, 'WORKSPACE', MEMORY_TOKEN_BUDGET);
  pack(candidateProject, 'PROJECT', MEMORY_TOKEN_BUDGET);

  return {
    selectedWorkspace: workspace.kept,
    selectedProject: project.kept,
    truncatedScopes: MEMORY_SCOPES.filter((scope) =>
      scope === 'PROJECT'
        ? project.kept.length < candidateProject.length
        : workspace.kept.length < candidateWorkspace.length,
    ),
  };
}

export function renderMemoryBlock(entries: MemoryRecord[]): MemoryBlockResult {
  const active = entries.filter((row) => row.status === 'ACTIVE');
  const { selectedWorkspace, selectedProject, truncatedScopes } = selectWithinBudget(active);
  const block = formatBlock(selectedWorkspace, selectedProject);
  return {
    block,
    truncated: truncatedScopes.length > 0,
    truncatedScopes,
    tokenEstimate: estimateTokens(block),
  };
}

function asRecord(row: {
  id: string;
  scope: string;
  projectId: string | null;
  category: string;
  content: string;
  source: string;
  status: string;
  createdAt: Date;
}): MemoryRecord {
  return {
    id: row.id,
    scope: row.scope === 'WORKSPACE' ? 'WORKSPACE' : 'PROJECT',
    projectId: row.projectId,
    category: MEMORY_CATEGORIES.includes(row.category as MemoryCategory)
      ? (row.category as MemoryCategory)
      : 'context',
    content: row.content,
    source: row.source === 'extracted' ? 'extracted' : 'manual',
    status:
      row.status === 'PENDING' ? 'PENDING' : row.status === 'ARCHIVED' ? 'ARCHIVED' : 'ACTIVE',
    createdAt: row.createdAt,
  };
}

export async function buildMemoryBlock(projectId: string): Promise<MemoryBlockResult> {
  const rows = await prisma.memoryEntry.findMany({
    where: {
      status: 'ACTIVE',
      OR: [
        { scope: 'WORKSPACE', projectId: null },
        { scope: 'PROJECT', projectId },
      ],
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
  });
  return renderMemoryBlock(rows.map(asRecord));
}
