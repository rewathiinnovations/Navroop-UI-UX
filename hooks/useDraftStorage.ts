"use client";

import { useCallback, useEffect, useState } from "react";
import { isStackId, type StackId } from "@/lib/stacks";

export const PENDING_PROMPT_KEY = "navroop_pending_prompt";

/** Hero / pending-prompt UI default. Zod createProject still defaults to REACT. */
export const DRAFT_DEFAULT_STACK: StackId = "NEXTJS";

export type DraftRecord = {
  text: string;
  stack: StackId;
  savedAt: number;
};

function resolveDraftStack(value: unknown): StackId {
  return isStackId(value) ? value : DRAFT_DEFAULT_STACK;
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
    };
  } catch {
    return null;
  }
}

export function writeDraftStorage(
  key: string,
  text: string,
  stack: StackId = DRAFT_DEFAULT_STACK,
) {
  if (typeof window === "undefined") return;
  const record: DraftRecord = {
    text,
    stack: resolveDraftStack(stack),
    savedAt: Date.now(),
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
  const [ready, setReady] = useState(false);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);

  useEffect(() => {
    const stored = readDraftStorage(key);
    setValue(stored?.text ?? "");
    setStack(stored?.stack ?? DRAFT_DEFAULT_STACK);
    setLoadedKey(key);
    setReady(true);
  }, [key]);

  useEffect(() => {
    if (!ready || loadedKey !== key) return;
    const timer = window.setTimeout(() => {
      writeDraftStorage(key, value, stack);
    }, debounceMs);
    return () => window.clearTimeout(timer);
  }, [debounceMs, key, loadedKey, ready, stack, value]);

  const flush = useCallback(
    (next = value, nextStack = stack) => {
      writeDraftStorage(key, next, nextStack);
    },
    [key, stack, value],
  );

  const clear = useCallback(() => {
    clearDraftStorage(key);
    setValue("");
    setStack(DRAFT_DEFAULT_STACK);
  }, [key]);

  return { value, setValue, stack, setStack, ready, flush, clear };
}
