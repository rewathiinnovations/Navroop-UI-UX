'use client';

import { useCallback, useEffect, useState } from 'react';
import { PROJECT_FILES_CHANGED_EVENT } from '@/lib/preview/events';

/** An earlier version is on screen because the current one does not build. */
export type HeldBackVersion = {
  checkpointId: string;
  label: string;
  createdAt: string;
};

export type ProjectFiles = {
  stack: string;
  /** Decides the starter stylesheet's token block, so the preview shows this project's palette. */
  designDirection: string | null;
  files: Record<string, string>;
  /**
   * Set when the server declined to serve the current files because they failed validation.
   *
   * It must reach the UI. Substituting an older site silently would leave someone looking at
   * a page without the change they just asked for and no way to tell whether the request was
   * ignored, so the workspace renders a banner off this.
   */
  heldBack: HeldBackVersion | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
};

/**
 * The project's stored files, which are what the preview compiles.
 *
 * Refetches when a generation settles or a checkpoint is restored — there is
 * no dev server to hot-reload any more, so that event is how the preview
 * learns the code changed.
 */
export function useProjectFiles(projectId: string | null): ProjectFiles {
  const [stack, setStack] = useState('NEXTJS');
  const [designDirection, setDesignDirection] = useState<string | null>(null);
  const [files, setFiles] = useState<Record<string, string>>({});
  const [heldBack, setHeldBack] = useState<HeldBackVersion | null>(null);
  const [loading, setLoading] = useState(Boolean(projectId));
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState(0);

  const reload = useCallback(() => setToken((value) => value + 1), []);

  useEffect(() => {
    if (!projectId) {
      setFiles({});
      setHeldBack(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    fetch(`/api/projects/${projectId}/files`)
      .then(async (response) => {
        if (!response.ok) throw new Error(`Could not load the project files (${response.status})`);
        return (await response.json()) as {
          stack: string;
          designDirection?: string | null;
          files: Record<string, string>;
          heldBack?: HeldBackVersion | null;
        };
      })
      .then((data) => {
        if (cancelled) return;
        setStack(data.stack);
        setDesignDirection(data.designDirection ?? null);
        setFiles(data.files ?? {});
        setHeldBack(data.heldBack ?? null);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : 'Could not load the project files');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, token]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.addEventListener(PROJECT_FILES_CHANGED_EVENT, reload);
    return () => window.removeEventListener(PROJECT_FILES_CHANGED_EVENT, reload);
  }, [reload]);

  return { stack, designDirection, files, heldBack, loading, error, reload };
}
