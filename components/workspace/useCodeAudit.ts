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
import { PROJECT_FILES_CHANGED_EVENT } from '@/lib/preview/events';
import {
  AUDIT_REFRESH_FAILED,
  AUDIT_UNREACHABLE,
  auditPollDecision,
  isTerminalAuditStatus,
  terminalAuditMessage,
  type AuditRefreshOutcome,
} from './audit-poll';

export { AUDIT_REFRESH_FAILED, AUDIT_UNREACHABLE };

/**
 * The body of the hook's `refresh`, lifted out so the failure paths can be
 * exercised without rendering. `refresh` is called as `void refresh()` from the
 * mount effect and from every poll tick, so an unhandled rejection here
 * (offline, a 500, a redeploy mid-flight) used to be an unhandled rejection
 * every 2 seconds. The catch reports rather than swallows: a Quality panel
 * showing stale findings and no explanation is the "paid, nothing happened,
 * told nothing" shape F-819 closed.
 *
 * It answers with the outcome rather than `void` because the caller has to act
 * on it. A failed refresh used to set only the error — `scanning` was left
 * exactly as the last successful tick found it, so a scan the user started and
 * then lost (project deleted in another tab, session cookie expired) latched
 * `scanning` true and the poll asked a permanently-refusing endpoint every two
 * seconds for the life of the tab, on both sub-tabs. Clearing `scanning` on a
 * terminal refusal is what ends that.
 */
export async function applyLatestCodeAudit(
  projectId: string,
  set: {
    setError: (value: string | null) => void;
    setAudit: (value: PublicCodeAudit | null) => void;
    setScanning: (value: boolean) => void;
    setHasFiles: (value: boolean) => void;
    setFilesHint: (value: string | null) => void;
  },
): Promise<AuditRefreshOutcome> {
  try {
    const result = await getLatestCodeAudit(projectId);
    if (!result.ok) {
      if (isTerminalAuditStatus(result.status)) {
        set.setError(terminalAuditMessage(result.status, result.error));
        // A scan nobody can observe any more must not keep claiming to run: the
        // spinner would never stop and the Scan button would never come back.
        set.setScanning(false);
        return 'terminal';
      }
      set.setError(result.error);
      return 'transient';
    }
    // F-819: a detached scan that failed reports through `lastError`; the old
    // unconditional `setError(null)` erased it and left "paid, nothing
    // happened, told nothing".
    set.setError(result.data.lastError);
    set.setAudit(result.data.audit);
    set.setScanning(result.data.scanning);
    set.setHasFiles(result.data.hasFiles);
    set.setFilesHint(result.data.filesHint);
    return 'ok';
  } catch {
    set.setError(AUDIT_REFRESH_FAILED);
    return 'transient';
  }
}

export function useCodeAudit(projectId: string | null) {
  const [audit, setAudit] = useState<PublicCodeAudit | null>(null);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Unknown (nothing has loaded yet) counts as not-ready, the same as
  // `PublishPanel`'s `canPublish` starting `false` until its own state has
  // loaded — a project is never assumed scannable before this resolves.
  const [hasFiles, setHasFiles] = useState(false);
  const [filesHint, setFilesHint] = useState<string | null>(null);
  // Consecutive failed refreshes, and whether the endpoint has refused in a way
  // that will not change. Together they are the poll's whole stop condition —
  // see `auditPollDecision`, which owns the rule for both hooks.
  const [failures, setFailures] = useState(0);
  const [stopped, setStopped] = useState(false);

  const refresh = useCallback(async () => {
    if (!projectId) return;
    const outcome = await applyLatestCodeAudit(projectId, {
      setError,
      setAudit,
      setScanning,
      setHasFiles,
      setFilesHint,
    });
    if (outcome === 'terminal') {
      setStopped(true);
      return;
    }
    setFailures((count) => (outcome === 'transient' ? count + 1 : 0));
  }, [projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // "Has this project gained files yet" is not the timer's question. The
  // workspace already broadcasts `PROJECT_FILES_CHANGED_EVENT` when a generation
  // settles or a checkpoint is restored — the same signal the preview rebuilds
  // on — so one refresh on that event re-enables Scan the moment a build that
  // started before this panel opened finishes, at no cost while nothing happens.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onFilesChanged = () => {
      void refresh();
    };
    window.addEventListener(PROJECT_FILES_CHANGED_EVENT, onFilesChanged);
    return () => window.removeEventListener(PROJECT_FILES_CHANGED_EVENT, onFilesChanged);
  }, [refresh]);

  // Watches a scan in flight, and nothing else. Every way of not polling changes
  // one of this effect's deps, so the cleanup tears the interval down instead of
  // a countdown clearing it from inside the callback with nothing able to re-arm
  // it. (The round-1 guard here was `if (!projectId || (!scanning && hasFiles))
  // return;`, which never returned on a project that never gains files; round 2
  // answered that with a tick budget, which expired under builds that legitimately
  // run for longer than it. Neither question belongs on this timer.)
  useEffect(() => {
    if (!projectId) return;
    const decision = auditPollDecision({ scanning, failures, stopped });
    if (!decision.poll) {
      // Giving up silently would leave a spinner that means nothing and a Scan
      // button that never returns. Say what happened and hand the panel back.
      if (decision.reason === 'unreachable') {
        setError(AUDIT_UNREACHABLE);
        setScanning(false);
      }
      return;
    }
    const timer = window.setInterval(() => {
      void refresh();
    }, decision.intervalMs);
    return () => window.clearInterval(timer);
  }, [projectId, refresh, scanning, failures, stopped]);

  const scan = useCallback(async () => {
    if (!projectId) return { ok: false as const, error: 'Project is not ready' };
    setError(null);
    // A press of Scan is a fresh attempt at everything, including at a server
    // that had stopped answering — otherwise a single outage would leave the
    // panel stopped for the life of the tab.
    setFailures(0);
    setStopped(false);
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

  return { audit, scanning, error, hasFiles, filesHint, scan, fixOne, fixAll, toggleIgnore, refresh };
}
