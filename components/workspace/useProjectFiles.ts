'use client';

import { useCallback, useEffect, useState } from 'react';
import { PROJECT_FILES_CHANGED_EVENT } from '@/lib/preview/events';

export type ProjectFiles = {
  stack: string;
  /** Decides the starter stylesheet's token block, so the preview shows this project's palette. */
  designDirection: string | null;
  files: Record<string, string>;
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
  const [loading, setLoading] = useState(Boolean(projectId));
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState(0);

  const reload = useCallback(() => setToken((value) => value + 1), []);

  useEffect(() => {
    if (!projectId) {
      setFiles({});
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
        };
      })
      .then((data) => {
        if (cancelled) return;
        setStack(data.stack);
        setDesignDirection(data.designDirection ?? null);
        setFiles(data.files ?? {});
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

  return { stack, designDirection, files, loading, error, reload };
}
