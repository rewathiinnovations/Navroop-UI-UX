'use client';

import { useState } from 'react';
import { cn } from '@/utils/cn';
import StudioLogo from '@/components/app/studio/StudioLogo';
import { BrowserPreview } from '@/components/workspace/BrowserPreview';
import PreviewDeviceToolbar from '@/components/workspace/PreviewDeviceToolbar';
import type { PublicPreviewSite } from '@/lib/preview/public-view';
import {
  formatPreviewSize,
  getPreviewDevice,
  rotateDeviceSize,
  type PreviewDeviceKey,
} from '@/lib/preview/devices';

/**
 * Light Navroop chrome around the same in-browser preview as the workspace.
 * Generated JS runs in BrowserPreview's srcdoc iframe — never top-level (F-140).
 */
export default function PublicPreviewShell({ site }: { site: PublicPreviewSite | null }) {
  const [device, setDevice] = useState<PreviewDeviceKey>('desktop');
  const [rotated, setRotated] = useState(false);

  const spec = getPreviewDevice(device);
  const size =
    spec.width != null && spec.height != null && rotated
      ? rotateDeviceSize(spec.width, spec.height)
      : spec;
  const ready = site?.ok === true;

  return (
    <div className="flex h-screen min-h-0 flex-col bg-[var(--studio-bg)]">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-8 border-b border-[var(--studio-line)] px-10 py-6">
        <div className="flex items-center gap-10">
          <StudioLogo href="/" />
          <p className="text-[13px] font-medium text-[var(--studio-muted)]">Preview</p>
        </div>
        {ready ? (
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
        {ready ? (
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
            <BrowserPreview
              stack={site.stack}
              files={site.files}
              designDirection={site.designDirection}
              className="h-full w-full"
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
