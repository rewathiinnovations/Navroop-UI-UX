'use client';

import { formatLockRemaining, lockWorkingMessage } from '@/lib/projects/lock-client';
import type { PresenceLock } from './useProjectPresence';

export default function LockBar({
  lock,
  showRelease,
  onRelease,
}: {
  lock: PresenceLock;
  showRelease?: boolean;
  onRelease?: () => void;
}) {
  if (!lock.locked || !lock.heldBy) return null;
  const remaining = lock.expiresAt ? formatLockRemaining(lock.expiresAt) : null;
  return (
    <div
      className="flex items-center justify-between gap-8 border-t border-amber-200 bg-amber-50 px-12 py-8 text-[12px] text-amber-950"
      role="status"
    >
      <p>
        {lockWorkingMessage(lock.heldBy.name)}
        {remaining ? ` · ${remaining}` : ''}
      </p>
      {showRelease ? (
        <button
          type="button"
          onClick={onRelease}
          className="shrink-0 rounded-8 border border-amber-300 bg-white px-8 py-4 text-[11px] font-medium text-amber-950 hover:bg-amber-100"
        >
          Release lock
        </button>
      ) : null}
    </div>
  );
}
