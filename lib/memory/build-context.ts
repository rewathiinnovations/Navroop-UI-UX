import { estimateTokens } from '@/lib/generation/token-estimate';
import { prisma } from '@/lib/db';
import {
  MEMORY_CATEGORIES,
  MEMORY_TOKEN_BUDGET,
  type MemoryBlockResult,
  type MemoryCategory,
  type MemoryRecord,
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

function groupLines(entries: MemoryRecord[]) {
  const lines: string[] = [];
  let current: MemoryCategory | null = null;
  for (const row of [...entries].sort(byCategoryThenNewest)) {
    if (row.category !== current) {
      current = row.category;
      lines.push(`#### ${row.category}`);
    }
    lines.push(`- ${row.content.trim()}`);
  }
  return lines;
}

function formatBlock(workspace: MemoryRecord[], project: MemoryRecord[]) {
  if (workspace.length === 0 && project.length === 0) return '';
  const parts = [
    '## Brain memory',
    'Durable preferences. Do not treat as one-off task instructions.',
  ];
  if (workspace.length > 0) {
    parts.push('', '### Workspace', 'Applies to every project.', ...groupLines(workspace));
  }
  if (project.length > 0) {
    parts.push('', '### This project', ...groupLines(project));
  }
  return parts.join('\n');
}

function selectWithinBudget(active: MemoryRecord[]) {
  const workspace = active.filter((row) => row.scope === 'WORKSPACE').sort(byNewest);
  const project = active.filter((row) => row.scope === 'PROJECT').sort(byNewest);
  const selectedWorkspace: MemoryRecord[] = [];
  const selectedProject: MemoryRecord[] = [];
  let truncated = false;

  const fits = (nextWorkspace: MemoryRecord[], nextProject: MemoryRecord[]) =>
    estimateTokens(formatBlock(nextWorkspace, nextProject)) <= MEMORY_TOKEN_BUDGET;

  for (const row of workspace) {
    const next = [...selectedWorkspace, row];
    if (!fits(next, selectedProject)) {
      truncated = true;
      break;
    }
    selectedWorkspace.push(row);
  }

  if (!truncated) {
    for (const row of project) {
      const next = [...selectedProject, row];
      if (!fits(selectedWorkspace, next)) {
        truncated = true;
        break;
      }
      selectedProject.push(row);
    }
  }

  return { selectedWorkspace, selectedProject, truncated };
}

export function renderMemoryBlock(entries: MemoryRecord[]): MemoryBlockResult {
  const active = entries.filter((row) => row.status === 'ACTIVE');
  const { selectedWorkspace, selectedProject, truncated } = selectWithinBudget(active);
  const block = formatBlock(selectedWorkspace, selectedProject);
  return {
    block,
    truncated,
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
    status: row.status === 'PENDING' ? 'PENDING' : row.status === 'ARCHIVED' ? 'ARCHIVED' : 'ACTIVE',
    createdAt: row.createdAt,
  };
}

export async function buildMemoryBlock(projectId: string): Promise<MemoryBlockResult> {
  const rows = await prisma.memoryEntry.findMany({
    where: {
      status: 'ACTIVE',
      OR: [{ scope: 'WORKSPACE', projectId: null }, { scope: 'PROJECT', projectId }],
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
  });
  return renderMemoryBlock(rows.map(asRecord));
}
