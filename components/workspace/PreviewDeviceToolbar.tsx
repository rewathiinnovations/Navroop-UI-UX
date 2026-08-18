'use client';

import { useEffect, useRef, useState } from 'react';
import { Monitor, RotateCw, Smartphone, Tablet } from 'lucide-react';
import { cn } from '@/utils/cn';
import { PREVIEW_DEVICES, type PreviewDeviceKey } from '@/lib/preview/devices';
import Hint from './Hint';

const DEVICE_ICONS = {
  smartphone: Smartphone,
  tablet: Tablet,
  monitor: Monitor,
} as const;

export default function PreviewDeviceToolbar({
  device,
  rotated,
  sizeLabel,
  scaleLabel,
  compact: compactProp,
  onDeviceChange,
  onToggleRotate,
}: {
  device: PreviewDeviceKey;
  rotated: boolean;
  sizeLabel: string;
  scaleLabel: string | null;
  compact?: boolean;
  onDeviceChange: (key: PreviewDeviceKey) => void;
  onToggleRotate: () => void;
}) {
  const barRef = useRef<HTMLDivElement>(null);
  const [measuredCompact, setMeasuredCompact] = useState(false);
  const compact = compactProp ?? measuredCompact;

  useEffect(() => {
    if (compactProp != null) return;
    const node = barRef.current?.parentElement;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => {
      setMeasuredCompact(entry.contentRect.width < 720);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [compactProp]);

  return (
    <div ref={barRef} className="flex min-w-0 items-center gap-6">
      <div
        role="radiogroup"
        aria-label="Preview device"
        className="inline-flex rounded-10 bg-[var(--studio-bg)] p-2"
      >
        {PREVIEW_DEVICES.map((item) => {
          const Icon = DEVICE_ICONS[item.icon];
          const selected = device === item.key;
          return (
            <button
              key={item.key}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={item.label}
              onClick={() => onDeviceChange(item.key)}
              className={cn(
                'inline-flex items-center gap-6 rounded-8 px-8 py-5 text-[12px] font-medium transition-colors',
                selected
                  ? 'bg-[var(--studio-surface)] text-[var(--studio-fg)] shadow-sm'
                  : 'text-[var(--studio-muted)] hover:text-[var(--studio-fg)]',
              )}
            >
              <Icon className="size-14" />
              <span className={cn(compact && 'sr-only')}>{item.label}</span>
            </button>
          );
        })}
      </div>

      {sizeLabel ? (
        <span className="tabular-nums text-[12px] text-[var(--studio-faint)]">{sizeLabel}</span>
      ) : null}
      {scaleLabel ? (
        <span className="rounded-full bg-[var(--studio-bg)] px-8 py-2 text-[11px] font-medium text-[var(--studio-muted)]">
          {scaleLabel}
        </span>
      ) : null}

      {device !== 'desktop' ? (
        <Hint label="Rotate">
          <button
            type="button"
            onClick={onToggleRotate}
            aria-label="Rotate preview"
            aria-pressed={rotated}
            className="inline-flex size-32 items-center justify-center rounded-10 text-[var(--studio-muted)] hover:bg-[var(--studio-surface-hover)] hover:text-[var(--studio-fg)]"
          >
            <RotateCw className="size-14" />
          </button>
        </Hint>
      ) : null}
    </div>
  );
}
