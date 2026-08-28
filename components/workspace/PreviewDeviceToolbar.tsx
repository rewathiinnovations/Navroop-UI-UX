'use client';

import { useState } from 'react';
import { ChevronDown, Monitor, RotateCw, Smartphone, Tablet } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/shadcn/dropdown-menu';
import { cn } from '@/utils/cn';
import {
  PREVIEW_DEVICES,
  getPreviewDevice,
  isPreviewDeviceKey,
  type PreviewDeviceKey,
} from '@/lib/preview/devices';
import { WORKSPACE_MENU_ITEM } from './WorkspaceViewControls';
import Hint from './Hint';

const DEVICE_ICONS = {
  smartphone: Smartphone,
  tablet: Tablet,
  monitor: Monitor,
} as const;

/**
 * Preview device sizes as a dropdown instead of a row of icon-only pills.
 * The trigger names the device on screen (Desktop / Mobile / Tablet); the
 * items are menuitemradio rows with icon + label. The trigger is min-w-[110px]
 * (icon + "Desktop" + chevron) so a shorter label does not shift the header;
 * the row is min-w-[158px] so the rotate slot is reserved too. Rotate and
 * scale-to-fit stay beside the menu — they are not device choices.
 */
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
  const [open, setOpen] = useState(false);
  const current = getPreviewDevice(device);
  const TriggerIcon = DEVICE_ICONS[current.icon];

  return (
    <div className="flex min-w-[158px] shrink-0 items-center gap-4">
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`Preview device: ${current.label}`}
            className={cn(
              'inline-flex min-h-[44px] min-w-[110px] shrink-0 items-center justify-between gap-4 whitespace-nowrap rounded-full border border-[var(--studio-line)] px-10 text-[12px] font-medium transition-colors',
              'text-[var(--studio-muted)] hover:bg-[var(--studio-surface-hover)] hover:text-[var(--studio-fg)]',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--studio-ring)]',
            )}
          >
            <TriggerIcon className="size-15" aria-hidden />
            <span>{current.label}</span>
            <ChevronDown className="size-12" aria-hidden />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          sideOffset={6}
          collisionPadding={8}
          aria-label="Preview device"
          className="studio-portal z-40 w-[176px] rounded-12 border-[var(--studio-line)] bg-[var(--studio-surface)] p-4 text-[var(--studio-fg)] shadow-sm"
        >
          <DropdownMenuRadioGroup
            value={device}
            onValueChange={(next) => {
              if (isPreviewDeviceKey(next)) onDeviceChange(next);
            }}
          >
            {PREVIEW_DEVICES.map((item) => {
              const Icon = DEVICE_ICONS[item.icon];
              const selected = device === item.key;
              return (
                <DropdownMenuRadioItem
                  key={item.key}
                  value={item.key}
                  aria-label={item.label}
                  className={cn(
                    WORKSPACE_MENU_ITEM,
                    selected ? 'font-medium text-[var(--studio-fg)]' : 'text-[var(--studio-muted)]',
                  )}
                >
                  <Icon className="size-14" aria-hidden />
                  {item.label}
                  {selected && sizeLabel ? (
                    <span className="ml-auto truncate pl-8 text-[var(--studio-faint)]">
                      {sizeLabel}
                    </span>
                  ) : null}
                </DropdownMenuRadioItem>
              );
            })}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>

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
              'studio-icon-hit inline-flex shrink-0 items-center justify-center rounded-full transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--studio-ring)]',
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
