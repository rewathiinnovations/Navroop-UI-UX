'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  fixAllCodeFindings,
  fixCodeFinding,
  getLatestCodeAudit,
  runCodeAudit,
  toggleIgnoreCodeFinding,
} from '@/lib/audit/actions';
import type { PublicCodeAudit } from '@/lib/audit/types';

const POLL_MS = 2000;

export function useCodeAudit(projectId: string | null) {
  const [audit, setAudit] = useState<PublicCodeAudit | null>(null);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!projectId) return;
    const result = await getLatestCodeAudit(projectId);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    // F-819: a detached scan that failed reports through `lastError`; the old
    // unconditional `setError(null)` erased it and left "paid, nothing
    // happened, told nothing".
    setError(result.data.lastError);
    setAudit(result.data.audit);
    setScanning(result.data.scanning);
  }, [projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!projectId || !scanning) return;
    const timer = window.setInterval(() => {
      void refresh();
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [projectId, refresh, scanning]);

  const scan = useCallback(async () => {
    if (!projectId) return { ok: false as const, error: 'Project is not ready' };
    setError(null);
    setScanning(true);
    const result = await runCodeAudit(projectId);
    if (!result.ok) {
      setScanning(false);
      if (result.status === 409) {
        const { emitLockConflict, parseLockConflict } = await import('@/lib/projects/lock-client');
        const conflict = parseLockConflict(409, result);
        if (conflict) emitLockConflict(conflict);
        return result;
      }
      setError(result.error);
      return result;
    }
    void refresh();
    return result;
  }, [projectId, refresh]);

  const fixOne = useCallback(
    async (findingId: string) => {
      if (!projectId) return { ok: false as const, error: 'Project is not ready' };
      const result = await fixCodeFinding(projectId, findingId);
      if (!result.ok) {
        setError(result.error);
        return result;
      }
      await refresh();
      return { ok: true as const, promptContext: result.data.promptContext };
    },
    [projectId, refresh],
  );

  const fixAll = useCallback(async () => {
    if (!projectId) return { ok: false as const, error: 'Project is not ready' };
    const result = await fixAllCodeFindings(projectId);
    if (!result.ok) {
      setError(result.error);
      return result;
    }
    await refresh();
    return { ok: true as const, promptContext: result.data.promptContext };
  }, [projectId, refresh]);

  const toggleIgnore = useCallback(
    async (findingId: string) => {
      if (!projectId) return { ok: false as const, error: 'Project is not ready' };
      const result = await toggleIgnoreCodeFinding(projectId, findingId);
      if (!result.ok) {
        setError(result.error);
        return result;
      }
      setAudit(result.data);
      return result;
    },
    [projectId],
  );

  return { audit, scanning, error, scan, fixOne, fixAll, toggleIgnore, refresh };
}
