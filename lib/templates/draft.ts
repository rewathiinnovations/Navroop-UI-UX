import {
  DEFAULT_DESIGN_DIRECTION,
  isDesignDirectionId,
  type DesignDirectionId,
} from '@/lib/design/directions';
import { parseDraftImportMode, resolveImportMode, type ImportMode } from '@/lib/import/mode';
import { isStackId, type StackId } from '@/lib/stacks';

export const DRAFT_DEFAULT_STACK: StackId = 'NEXTJS';

export type TemplateDraftRecord = {
  text: string;
  stack: StackId;
  savedAt: number;
  designDirection: DesignDirectionId;
  importMode: ImportMode;
  templateId?: string | null;
};

function resolveDraftStack(value: unknown): StackId {
  return isStackId(value) ? value : DRAFT_DEFAULT_STACK;
}

function resolveDraftDirection(value: unknown): DesignDirectionId {
  return isDesignDirectionId(value) ? value : DEFAULT_DESIGN_DIRECTION;
}

export function parseDraftRecord(value: unknown): TemplateDraftRecord | null {
  if (!value || typeof value !== 'object') return null;
  const parsed = value as Partial<TemplateDraftRecord>;
  if (typeof parsed.text !== 'string') return null;
  return {
    text: parsed.text,
    stack: resolveDraftStack(parsed.stack),
    savedAt: typeof parsed.savedAt === 'number' ? parsed.savedAt : Date.now(),
    designDirection: resolveDraftDirection(parsed.designDirection),
    importMode: parseDraftImportMode(parsed),
    templateId:
      typeof parsed.templateId === 'string' && parsed.templateId ? parsed.templateId : null,
  };
}

export function serializeDraftRecord(draft: TemplateDraftRecord) {
  return JSON.stringify({
    text: draft.text,
    stack: resolveDraftStack(draft.stack),
    savedAt: typeof draft.savedAt === 'number' ? draft.savedAt : Date.now(),
    designDirection: resolveDraftDirection(draft.designDirection),
    importMode: resolveImportMode(draft.importMode),
    templateId: draft.templateId || null,
  } satisfies TemplateDraftRecord);
}

export function applyTemplateDraft(
  current: Omit<TemplateDraftRecord, 'templateId'> & { templateId?: string | null },
  edit: { templateId: string; prompt: string },
): TemplateDraftRecord {
  return {
    ...current,
    text: edit.prompt,
    templateId: edit.templateId,
    savedAt: Date.now(),
  };
}
