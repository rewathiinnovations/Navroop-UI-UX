'use client';

import { useState } from 'react';
import { cn } from '@/utils/cn';
import StudioLogo from '@/components/app/studio/StudioLogo';
import PreviewDeviceToolbar from '@/components/workspace/PreviewDeviceToolbar';
import {
  formatPreviewSize,
  getPreviewDevice,
  rotateDeviceSize,
  type PreviewDeviceKey,
} from '@/lib/preview/devices';

/**
 * Light Navroop chrome around a sandboxed iframe. The site itself must come
 * from the distinct preview origin — never generated JS on the app origin (F-140).
 */
export default function PublicPreviewShell({ iframeSrc }: { iframeSrc: string | null }) {
  const [device, setDevice] = useState<PreviewDeviceKey>('desktop');
  const [rotated, setRotated] = useState(false);

  const spec = getPreviewDevice(device);
  const size =
    spec.width != null && spec.height != null && rotated
      ? rotateDeviceSize(spec.width, spec.height)
      : spec;

  return (
    <div className="flex h-screen min-h-0 flex-col bg-[var(--studio-bg)]">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-8 border-b border-[var(--studio-line)] px-10 py-6">
        <div className="flex items-center gap-10">
          <StudioLogo href="/" />
          <p className="text-[13px] font-medium text-[var(--studio-muted)]">Preview</p>
        </div>
        {iframeSrc ? (
          <PreviewDeviceToolbar
            device={device}
            rotated={rotated}
            sizeLabel={
              size.width != null && size.height != null
                ? formatPreviewSize(size.width, size.height)
                : ''
            }
            scaleLabel={null}
            onDeviceChange={setDevice}
            onToggleRotate={() => setRotated((value) => !value)}
          />
        ) : null}
      </header>
      <main className="flex min-h-0 flex-1 items-start justify-center overflow-auto bg-[var(--studio-surface)] p-16">
        {iframeSrc ? (
          <div
            className={cn(
              'overflow-hidden border border-[var(--studio-line)] bg-white transition-[width,height]',
              size.width != null && size.height != null ? 'rounded-16' : 'h-full w-full rounded-12',
            )}
            style={
              size.width != null && size.height != null
                ? { width: size.width, height: size.height }
                : undefined
            }
          >
            <iframe
              src={iframeSrc}
              title="Project preview"
              className="h-full w-full border-0 bg-white"
              sandbox="allow-scripts allow-forms allow-modals allow-popups"
              referrerPolicy="no-referrer"
            />
          </div>
        ) : (
          <div className="flex h-full items-center justify-center px-24 text-center">
            <p className="text-[13px] leading-5 text-[var(--studio-muted)]">
              Preview is not available
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
