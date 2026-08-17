'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  exitCheckpointPreview,
  fetchCheckpoints,
  previewCheckpoint,
  restoreCheckpoint,
  toggleCheckpointBookmark,
} from '@/lib/checkpoints/client';
import type { Checkpoint } from './types';

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
        return {
          ok: false as const,
          error: error instanceof Error ? error.message : 'Could not preview this version',
        };
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
      return {
        ok: false as const,
        error: error instanceof Error ? error.message : 'Could not return to the current version',
      };
    } finally {
      setBusy(false);
    }
  }, [busy, onRefresh, projectId]);

  const restore = useCallback(
    async (id: string) => {
      if (!projectId || busy) return { ok: false as const, error: 'Project is not ready' };
      const confirmed = window.confirm(
        'Restore this version? The current sandbox will change and a new checkpoint will be created.',
      );
      if (!confirmed) return { ok: false as const, error: 'cancelled' };
      setBusy(true);
      try {
        await restoreCheckpoint(projectId, id);
        setPreviewingId(null);
        await refresh();
        onRefresh?.();
        return { ok: true as const };
      } catch (error) {
        return {
          ok: false as const,
          error: error instanceof Error ? error.message : 'Could not restore this version',
        };
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
        return {
          ok: false as const,
          error: error instanceof Error ? error.message : 'Could not bookmark this version',
        };
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
