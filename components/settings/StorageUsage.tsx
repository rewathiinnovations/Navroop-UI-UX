'use client';

import { useEffect, useState } from 'react';
import { formatStorageBytes } from '@/lib/storage/format';

export default function StorageUsage() {
  const [used, setUsed] = useState<number | null>(null);
  const [limit, setLimit] = useState<number | null>(null);

  useEffect(() => {
    void fetch('/api/settings/storage')
      .then((response) => response.json())
      .then((data: { storageBytes?: number; storageLimitBytes?: number | null }) => {
        if (typeof data.storageBytes === 'number') setUsed(data.storageBytes);
        setLimit(typeof data.storageLimitBytes === 'number' ? data.storageLimitBytes : null);
      })
      .catch(() => undefined);
  }, []);

  if (used === null) return null;

  const capped = limit && limit > 0 ? Math.min(used / limit, 1) : 0;
  const label = limit && limit > 0
    ? `${formatStorageBytes(used)} of ${formatStorageBytes(limit)}`
    : `${formatStorageBytes(used)} used`;

  return (
    <section className="mb-40 space-y-10">
      <h2 className="text-[18px] font-medium text-[var(--studio-fg)]">Workspace storage</h2>
      <p className="text-[13px] text-[var(--studio-muted)]">{label}</p>
      {limit && limit > 0 ? (
        <div
          className="h-8 overflow-hidden rounded-full bg-[var(--studio-skeleton)]"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={limit}
          aria-valuenow={used}
          aria-label="Workspace storage used"
        >
          <div
            className="h-full rounded-full bg-[var(--studio-accent)]"
            style={{ width: `${Math.max(capped * 100, used > 0 ? 2 : 0)}%` }}
          />
        </div>
      ) : null}
      <p className="text-[12px] text-[var(--studio-faint)]">
        Deleted projects are permanently purged after 30 days.
      </p>
    </section>
  );
}
