'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  PROJECT_LOCK_EVENT,
  parseLockConflict,
  type LockConflictDetail,
} from '@/lib/projects/lock-client';

export type PresenceViewer = {
  id: string;
  name: string;
  avatarUrl: string | null;
};

export type PresenceLock = {
  locked: boolean;
  heldBy: { id: string; name: string } | null;
  expiresAt: string | null;
  reason: string | null;
};

type PresencePayload = {
  viewers?: PresenceViewer[];
  lock?: PresenceLock;
  contentVersion?: number;
  viewerId?: string;
  viewerRole?: string;
};

const POLL_MS = 15_000;
const HEARTBEAT_MS = 30_000;

export function useProjectPresence(projectId: string | null, options?: { selfBusy?: boolean }) {
  const [viewers, setViewers] = useState<PresenceViewer[]>([]);
  const [lock, setLock] = useState<PresenceLock>({
    locked: false,
    heldBy: null,
    expiresAt: null,
    reason: null,
  });
  const [viewerId, setViewerId] = useState<string | null>(null);
  const [viewerRole, setViewerRole] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [peerNote, setPeerNote] = useState<string | null>(null);
  const seenVersion = useRef<number | null>(null);
  const notedPeers = useRef(false);
  const selfBusyRef = useRef(Boolean(options?.selfBusy));
  useEffect(() => {
    selfBusyRef.current = Boolean(options?.selfBusy);
  });

  const applyPayload = useCallback((data: PresencePayload) => {
    const nextViewers = data.viewers ?? [];
    const nextLock = data.lock ?? { locked: false, heldBy: null, expiresAt: null, reason: null };
    setViewers(nextViewers);
    setLock(nextLock);
    if (data.viewerId) setViewerId(data.viewerId);
    if (data.viewerRole) setViewerRole(data.viewerRole);
    const version = typeof data.contentVersion === 'number' ? data.contentVersion : 0;
    if (seenVersion.current === null) {
      seenVersion.current = version;
    } else if (version > seenVersion.current) {
      const heldBySelf = Boolean(data.viewerId && nextLock.heldBy?.id === data.viewerId);
      if (heldBySelf || selfBusyRef.current) seenVersion.current = version;
      else setStale(true);
    }
    if (!notedPeers.current && data.viewerId) {
      const others = nextViewers.filter((row) => row.id !== data.viewerId);
      if (others.length > 0) {
        setPeerNote(`${others[0].name} also has this project open`);
        notedPeers.current = true;
      }
    }
  }, []);

  const pull = useCallback(
    async (heartbeat: boolean) => {
      if (!projectId) return;
      const response = await fetch(`/api/projects/${projectId}/presence`, {
        method: heartbeat ? 'POST' : 'GET',
      });
      if (!response.ok) return;
      const data = (await response.json().catch(() => ({}))) as PresencePayload;
      applyPayload(data);
    },
    [applyPayload, projectId],
  );

  useEffect(() => {
    seenVersion.current = null;
    notedPeers.current = false;
    setStale(false);
    setPeerNote(null);
    setViewers([]);
    setLock({ locked: false, heldBy: null, expiresAt: null, reason: null });
    if (!projectId) return;
    void pull(true);
    const poll = window.setInterval(() => {
      void pull(false);
    }, POLL_MS);
    const beat = window.setInterval(() => {
      void pull(true);
    }, HEARTBEAT_MS);
    return () => {
      window.clearInterval(poll);
      window.clearInterval(beat);
    };
  }, [projectId, pull]);

  useEffect(() => {
    const onConflict = (event: Event) => {
      const detail = (event as CustomEvent<LockConflictDetail>).detail;
      if (!detail) return;
      setLock({
        locked: true,
        heldBy: { id: '', name: detail.name },
        expiresAt: detail.expiresAt,
        reason: null,
      });
    };
    window.addEventListener(PROJECT_LOCK_EVENT, onConflict);
    return () => window.removeEventListener(PROJECT_LOCK_EVENT, onConflict);
  }, []);

  const releaseLock = useCallback(async () => {
    if (!projectId) return;
    const confirmed = window.confirm(
      "Release this lock? The other person's work may be lost.",
    );
    if (!confirmed) return;
    const response = await fetch(`/api/projects/${projectId}/lock/release`, { method: 'POST' });
    if (response.ok) {
      setLock({ locked: false, heldBy: null, expiresAt: null, reason: null });
      void pull(false);
    }
  }, [projectId, pull]);

  const others = viewers.filter((row) => row.id !== viewerId);
  const heldByOther = Boolean(lock.locked && lock.heldBy && lock.heldBy.id !== viewerId);
  const isAdmin = viewerRole === 'ADMIN';

  return {
    others,
    lock,
    heldByOther,
    isAdmin,
    stale,
    peerNote,
    dismissPeerNote: () => setPeerNote(null),
    releaseLock,
    applyConflictBody: (status: number, body: unknown) => {
      const conflict = parseLockConflict(status, body);
      if (conflict) {
        setLock({
          locked: true,
          heldBy: { id: '', name: conflict.name },
          expiresAt: conflict.expiresAt,
          reason: null,
        });
      }
      return conflict;
    },
  };
}
