'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DEFAULT_DESIGN_DIRECTION,
  isDesignDirectionId,
  type DesignDirectionId,
} from '@/lib/design/directions';
import { DEFAULT_IMPORT_MODE, resolveImportMode, type ImportMode } from '@/lib/import/mode';
import { isStackId, type StackId } from '@/lib/stacks';
import {
  parseDraftRecord,
  serializeDraftRecord,
  type TemplateDraftRecord,
} from '@/lib/templates/draft';

/**
 * The dashboard / landing hero draft, and nothing else.
 *
 * It is one key shared by every hero on every tab, so anything else that autosaved into it
 * destroyed what the reader was writing: the template sheet used to, and merely opening a
 * template card replaced the dashboard brief with that template's canned prompt (and left
 * its `templateId` behind for the next submission to inherit). Other prompt boxes get their
 * own key — `templateDraftKey`, or `navroop_draft_${projectId}` in the workspace composer.
 */
export const PENDING_PROMPT_KEY = 'navroop_pending_prompt';

/** Per-template draft for the template sheet. Never `PENDING_PROMPT_KEY`: see above. */
export function templateDraftKey(templateId: string) {
  return `navroop_template_draft_${templateId}`;
}

/** Hero / pending-prompt UI default. Matches Project.stack @default(NEXTJS). */
export const DRAFT_DEFAULT_STACK: StackId = 'NEXTJS';

export type DraftRecord = TemplateDraftRecord;

function resolveDraftStack(value: unknown): StackId {
  return isStackId(value) ? value : DRAFT_DEFAULT_STACK;
}

function resolveDraftDirection(value: unknown): DesignDirectionId {
  return isDesignDirectionId(value) ? value : DEFAULT_DESIGN_DIRECTION;
}

export function readDraftStorage(key: string): DraftRecord | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    return parseDraftRecord(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function writeDraftStorage(
  key: string,
  text: string,
  stack: StackId = DRAFT_DEFAULT_STACK,
  designDirection: DesignDirectionId = DEFAULT_DESIGN_DIRECTION,
  importMode: ImportMode = DEFAULT_IMPORT_MODE,
  templateId: string | null = null,
) {
  if (typeof window === 'undefined') return;
  const record: DraftRecord = {
    text,
    stack: resolveDraftStack(stack),
    savedAt: Date.now(),
    designDirection: resolveDraftDirection(designDirection),
    importMode: resolveImportMode(importMode),
    templateId,
  };
  window.localStorage.setItem(key, serializeDraftRecord(record));
}

export function clearDraftStorage(key: string) {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(key);
}

/**
 * Whether a mount/key-change hydration may overwrite what is currently in the draft.
 *
 * `editedForKey` is the key the in-memory draft was authored under, or null when nothing
 * has been edited since the last hydration. Storage only ever holds an older snapshot of
 * the same box, so anything the reader has already typed under this key outranks it.
 */
export function draftHydrationApplies(editedForKey: string | null, key: string) {
  return editedForKey !== key;
}

export function useDraftStorage(key: string, debounceMs = 500) {
  const [value, setValueState] = useState('');
  const [stack, setStackState] = useState<StackId>(DRAFT_DEFAULT_STACK);
  const [designDirection, setDesignDirectionState] =
    useState<DesignDirectionId>(DEFAULT_DESIGN_DIRECTION);
  const [importMode, setImportModeState] = useState<ImportMode>(DEFAULT_IMPORT_MODE);
  const [templateId, setTemplateIdState] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);

  /**
   * The draft key the current in-memory draft was authored under, or null when nothing has
   * been edited since the last hydration.
   *
   * Hydration reads localStorage in a mount effect, which lands *after* the field is on
   * screen and focusable. It used to assign `stored?.text ?? ""` unconditionally, so a
   * prompt typed in that window — wide on a cold compile, and the textarea is server
   * rendered so it accepts input well before React hydrates — was overwritten with the
   * empty string. The box emptied itself and the submit button greyed back out.
   *
   * Comparing against `key` rather than holding a boolean is what makes switching drafts
   * still work: typing in project A then opening project B leaves the ref reading `A`, so
   * B's stored draft loads normally.
   */
  const editedForKeyRef = useRef<string | null>(null);

  const markEdited = useCallback(() => {
    editedForKeyRef.current = key;
  }, [key]);

  const setValue = useCallback<typeof setValueState>(
    (next) => {
      markEdited();
      setValueState(next);
    },
    [markEdited],
  );
  const setStack = useCallback<typeof setStackState>(
    (next) => {
      markEdited();
      setStackState(next);
    },
    [markEdited],
  );
  const setDesignDirection = useCallback<typeof setDesignDirectionState>(
    (next) => {
      markEdited();
      setDesignDirectionState(next);
    },
    [markEdited],
  );
  const setImportMode = useCallback<typeof setImportModeState>(
    (next) => {
      markEdited();
      setImportModeState(next);
    },
    [markEdited],
  );
  const setTemplateId = useCallback<typeof setTemplateIdState>(
    (next) => {
      markEdited();
      setTemplateIdState(next);
    },
    [markEdited],
  );

  useEffect(() => {
    // Whatever the reader has already put in this draft outranks what storage held: the
    // stored copy is only ever an older snapshot of the same box.
    if (draftHydrationApplies(editedForKeyRef.current, key)) {
      const stored = readDraftStorage(key);
      setValueState(stored?.text ?? '');
      setStackState(stored?.stack ?? DRAFT_DEFAULT_STACK);
      setDesignDirectionState(stored?.designDirection ?? DEFAULT_DESIGN_DIRECTION);
      setImportModeState(stored?.importMode ?? DEFAULT_IMPORT_MODE);
      setTemplateIdState(stored?.templateId ?? null);
    }
    setLoadedKey(key);
    setReady(true);
  }, [key]);

  useEffect(() => {
    if (!ready || loadedKey !== key) return;
    const timer = window.setTimeout(() => {
      writeDraftStorage(key, value, stack, designDirection, importMode, templateId);
    }, debounceMs);
    return () => window.clearTimeout(timer);
  }, [debounceMs, designDirection, importMode, key, loadedKey, ready, stack, templateId, value]);

  const flush = useCallback(
    (
      next = value,
      nextStack = stack,
      nextDirection = designDirection,
      nextImportMode = importMode,
      nextTemplateId = templateId,
    ) => {
      writeDraftStorage(key, next, nextStack, nextDirection, nextImportMode, nextTemplateId);
    },
    [designDirection, importMode, key, stack, templateId, value],
  );

  const clear = useCallback(() => {
    clearDraftStorage(key);
    setValue('');
    setStack(DRAFT_DEFAULT_STACK);
    setDesignDirection(DEFAULT_DESIGN_DIRECTION);
    setImportMode(DEFAULT_IMPORT_MODE);
    setTemplateId(null);
  }, [key]);

  return {
    value,
    setValue,
    stack,
    setStack,
    designDirection,
    setDesignDirection,
    importMode,
    setImportMode,
    templateId,
    setTemplateId,
    ready,
    flush,
    clear,
  };
}
