'use client';

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
  compact: _compact,
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
  return (
    <div className="flex items-center gap-4">
      <div
        role="radiogroup"
        aria-label="Preview device"
        className="inline-flex min-h-[44px] items-center rounded-full border border-[var(--studio-line)] bg-[var(--studio-bg)] p-2"
      >
        {PREVIEW_DEVICES.map((item) => {
          const Icon = DEVICE_ICONS[item.icon];
          const selected = device === item.key;
          const hint = selected && sizeLabel ? `${item.label} · ${sizeLabel}` : item.label;
          return (
            <Hint key={item.key} label={hint}>
              <button
                type="button"
                role="radio"
                aria-checked={selected}
                aria-label={item.label}
                onClick={() => onDeviceChange(item.key)}
                className={cn(
                  'studio-icon-hit inline-flex items-center justify-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--studio-ring)]',
                  selected
                    ? 'bg-[var(--studio-surface)] text-[var(--studio-fg)] shadow-sm'
                    : 'text-[var(--studio-muted)] hover:text-[var(--studio-fg)]',
                )}
              >
                <Icon className="size-14" />
              </button>
            </Hint>
          );
        })}
      </div>

      {scaleLabel ? (
        <span className="hidden tabular-nums text-[11px] text-[var(--studio-faint)] xl:inline">
          {scaleLabel}
        </span>
      ) : null}

      {device !== 'desktop' ? (
        <Hint label={rotated ? 'Rotate to portrait' : 'Rotate to landscape'}>
          <button
            type="button"
            onClick={onToggleRotate}
            aria-label="Rotate preview"
            aria-pressed={rotated}
            className={cn(
              'studio-icon-hit inline-flex items-center justify-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--studio-ring)]',
              rotated
                ? 'bg-[var(--studio-surface)] text-[var(--studio-fg)] shadow-sm'
                : 'text-[var(--studio-muted)] hover:bg-[var(--studio-surface-hover)] hover:text-[var(--studio-fg)]',
            )}
          >
            <RotateCw className="size-14" />
          </button>
        </Hint>
      ) : null}
    </div>
  );
}
