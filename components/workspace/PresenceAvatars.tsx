'use client';

import Hint from './Hint';
import ImageWithFallback from './ImageWithFallback';
import type { PresenceViewer } from './useProjectPresence';

function initials(name: string) {
  return (
    name
      .split(' ')
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join('') || '?'
  );
}

export default function PresenceAvatars({ viewers }: { viewers: PresenceViewer[] }) {
  if (viewers.length === 0) return null;
  const names = viewers.map((row) => row.name).join(', ');
  return (
    <Hint label={names}>
      <div className="flex items-center pr-8" aria-label={`Viewing: ${names}`}>
        {viewers.slice(0, 4).map((row, index) => (
          <span
            key={row.id}
            className="inline-flex size-28 items-center justify-center rounded-full border-2 border-[var(--studio-header-bg)] bg-[var(--studio-surface-hover)] text-[10px] font-medium text-[var(--studio-fg)]"
            style={{ marginLeft: index === 0 ? 0 : -8, zIndex: 4 - index }}
          >
            {row.avatarUrl ? (
              <ImageWithFallback
                src={row.avatarUrl}
                alt=""
                className="size-full rounded-full object-cover"
                width={28}
                height={28}
                fallback={initials(row.name)}
              />
            ) : (
              initials(row.name)
            )}
          </span>
        ))}
        {viewers.length > 4 ? (
          <span className="-ml-8 inline-flex size-28 items-center justify-center rounded-full border-2 border-[var(--studio-header-bg)] bg-[var(--studio-fg)] text-[10px] text-[var(--studio-bg)]">
            +{viewers.length - 4}
          </span>
        ) : null}
      </div>
    </Hint>
  );
}
