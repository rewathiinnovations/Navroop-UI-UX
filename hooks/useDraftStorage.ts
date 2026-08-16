"use client";

import { useCallback, useEffect, useState } from "react";
import {
  DEFAULT_DESIGN_DIRECTION,
  isDesignDirectionId,
  type DesignDirectionId,
} from "@/lib/design/directions";
import { DEFAULT_IMPORT_MODE, parseDraftImportMode, resolveImportMode, type ImportMode } from "@/lib/import/mode";
import { isStackId, type StackId } from "@/lib/stacks";

export const PENDING_PROMPT_KEY = "navroop_pending_prompt";

/** Hero / pending-prompt UI default. Matches Project.stack @default(NEXTJS). */
export const DRAFT_DEFAULT_STACK: StackId = "NEXTJS";

export type DraftRecord = {
  text: string;
  stack: StackId;
  savedAt: number;
  designDirection: DesignDirectionId;
  importMode: ImportMode;
};

function resolveDraftStack(value: unknown): StackId {
  return isStackId(value) ? value : DRAFT_DEFAULT_STACK;
}

function resolveDraftDirection(value: unknown): DesignDirectionId {
  return isDesignDirectionId(value) ? value : DEFAULT_DESIGN_DIRECTION;
}

export function readDraftStorage(key: string): DraftRecord | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<DraftRecord>;
    if (typeof parsed.text !== "string") return null;
    return {
      text: parsed.text,
      stack: resolveDraftStack(parsed.stack),
      savedAt: typeof parsed.savedAt === "number" ? parsed.savedAt : Date.now(),
      designDirection: resolveDraftDirection(parsed.designDirection),
      importMode: parseDraftImportMode(parsed),
    };
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
) {
  if (typeof window === "undefined") return;
  const record: DraftRecord = {
    text,
    stack: resolveDraftStack(stack),
    savedAt: Date.now(),
    designDirection: resolveDraftDirection(designDirection),
    importMode: resolveImportMode(importMode),
  };
  window.localStorage.setItem(key, JSON.stringify(record));
}

export function clearDraftStorage(key: string) {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(key);
}

export function useDraftStorage(key: string, debounceMs = 500) {
  const [value, setValue] = useState("");
  const [stack, setStack] = useState<StackId>(DRAFT_DEFAULT_STACK);
  const [designDirection, setDesignDirection] = useState<DesignDirectionId>(DEFAULT_DESIGN_DIRECTION);
  const [importMode, setImportMode] = useState<ImportMode>(DEFAULT_IMPORT_MODE);
  const [ready, setReady] = useState(false);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);

  useEffect(() => {
    const stored = readDraftStorage(key);
    setValue(stored?.text ?? "");
    setStack(stored?.stack ?? DRAFT_DEFAULT_STACK);
    setDesignDirection(stored?.designDirection ?? DEFAULT_DESIGN_DIRECTION);
    setImportMode(stored?.importMode ?? DEFAULT_IMPORT_MODE);
    setLoadedKey(key);
    setReady(true);
  }, [key]);

  useEffect(() => {
    if (!ready || loadedKey !== key) return;
    const timer = window.setTimeout(() => {
      writeDraftStorage(key, value, stack, designDirection, importMode);
    }, debounceMs);
    return () => window.clearTimeout(timer);
  }, [debounceMs, designDirection, importMode, key, loadedKey, ready, stack, value]);

  const flush = useCallback(
    (next = value, nextStack = stack, nextDirection = designDirection, nextImportMode = importMode) => {
      writeDraftStorage(key, next, nextStack, nextDirection, nextImportMode);
    },
    [designDirection, importMode, key, stack, value],
  );

  const clear = useCallback(() => {
    clearDraftStorage(key);
    setValue("");
    setStack(DRAFT_DEFAULT_STACK);
    setDesignDirection(DEFAULT_DESIGN_DIRECTION);
    setImportMode(DEFAULT_IMPORT_MODE);
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
    ready,
    flush,
    clear,
  };
}
