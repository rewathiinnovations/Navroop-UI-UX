'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  exitCheckpointPreview,
  fetchCheckpoints,
  isLockConflictError,
  previewCheckpoint,
  restoreCheckpoint,
  toggleCheckpointBookmark,
} from '@/lib/checkpoints/client';
import type { Checkpoint } from './types';

/**
 * `locked` tells ProjectWorkspace to stay quiet: the client already raised the
 * LockBar for this conflict, so repeating it as a chat line says it twice. Preview,
 * exit and restore take the project lock server-side, so any of the three can report
 * it; the bookmark toggle takes no lock — it writes only `Checkpoint.isBookmarked` —
 * so `locked` is always false there. All four still go through this one helper so the
 * branch cannot be forgotten when a fifth call is added.
 */
function failed(error: unknown, fallback: string) {
  return {
    ok: false as const,
    error: error instanceof Error ? error.message : fallback,
    locked: isLockConflictError(error),
  };
}

export function useCheckpoints({
  projectId,
  isJobActive,
  generationStatus,
  onRefresh,
}: {
  projectId: string | null;
  isJobActive?: boolean;
  generationStatus?: string | null;
  onRefresh?: () => void;
}) {
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [previewingId, setPreviewingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!projectId) return;
    try {
      const rows = await fetchCheckpoints(projectId);
      setCheckpoints(rows);
    } catch {
      /* keep last known list */
    }
  }, [projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!projectId) return;
    if (isJobActive) return;
    if (generationStatus === 'ready') void refresh();
  }, [generationStatus, isJobActive, projectId, refresh]);

  const preview = useCallback(
    async (id: string) => {
      if (!projectId || busy) return { ok: false as const, error: 'Project is not ready' };
      setBusy(true);
      try {
        await previewCheckpoint(projectId, id);
        setPreviewingId(id);
        onRefresh?.();
        return { ok: true as const };
      } catch (error) {
        return failed(error, 'Could not preview this version');
      } finally {
        setBusy(false);
      }
    },
    [busy, onRefresh, projectId],
  );

  const exitPreview = useCallback(async () => {
    if (!projectId || busy) return { ok: false as const, error: 'Project is not ready' };
    setBusy(true);
    try {
      await exitCheckpointPreview(projectId);
      setPreviewingId(null);
      onRefresh?.();
      return { ok: true as const };
    } catch (error) {
      return failed(error, 'Could not return to the current version');
    } finally {
      setBusy(false);
    }
  }, [busy, onRefresh, projectId]);

  const restore = useCallback(
    async (id: string) => {
      if (!projectId || busy) return { ok: false as const, error: 'Project is not ready' };
      // Confirmation is ConfirmAction on the Restore button (VersionHistoryPanel).
      setBusy(true);
      try {
        await restoreCheckpoint(projectId, id);
        setPreviewingId(null);
        await refresh();
        onRefresh?.();
        return { ok: true as const };
      } catch (error) {
        return failed(error, 'Could not restore this version');
      } finally {
        setBusy(false);
      }
    },
    [busy, onRefresh, projectId, refresh],
  );

  const bookmark = useCallback(
    async (id: string) => {
      if (!projectId || busy) return { ok: false as const, error: 'Project is not ready' };
      setBusy(true);
      try {
        const updated = await toggleCheckpointBookmark(projectId, id);
        if (updated) {
          setCheckpoints((current) =>
            current.map((row) => (row.id === id ? { ...row, ...updated } : row)),
          );
        }
        return { ok: true as const };
      } catch (error) {
        return failed(error, 'Could not bookmark this version');
      } finally {
        setBusy(false);
      }
    },
    [busy, projectId],
  );

  return {
    checkpoints,
    latestCheckpoint: checkpoints[0] ?? null,
    previewing: Boolean(previewingId),
    preview,
    exitPreview,
    restore,
    bookmark,
    refresh,
  };
}
