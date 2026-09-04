'use client';

import { useState } from 'react';
import { useParams } from 'next/navigation';
import { cn } from '@/utils/cn';
import { BrowserPreview } from '@/components/workspace/BrowserPreview';
import PreviewDeviceToolbar from '@/components/workspace/PreviewDeviceToolbar';
import { useProjectFiles } from '@/components/workspace/useProjectFiles';
import {
  formatPreviewSize,
  getPreviewDevice,
  rotateDeviceSize,
  type PreviewDeviceKey,
} from '@/lib/preview/devices';

/**
 * Signed-in in-app preview. "Open in new tab" targets `/preview-view?projectId=&token=`.
 * This page stays for in-app use and uses the same BrowserPreview srcdoc renderer
 * as the workspace — not an iframe of that public URL (nested chrome) and not
 * a hosted snapshot origin. Generated JS never runs top-level (F-140).
 */
export default function ProjectPreviewPage() {
  const params = useParams();
  const projectId = typeof params.id === 'string' ? params.id : null;
  const projectFiles = useProjectFiles(projectId);
  const [device, setDevice] = useState<PreviewDeviceKey>('desktop');
  const [rotated, setRotated] = useState(false);
  const hasFiles = Object.keys(projectFiles.files).length > 0;
  const error = projectFiles.error;

  const spec = getPreviewDevice(device);
  const size =
    spec.width != null && spec.height != null && rotated
      ? rotateDeviceSize(spec.width, spec.height)
      : spec;

  return (
    <div className="flex h-screen min-h-0 flex-col bg-[var(--studio-bg)]">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-8 border-b border-[var(--studio-line)] px-10 py-6">
        <p className="text-[13px] font-medium text-[var(--studio-fg)]">Preview</p>
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
      </header>
      <main className="flex min-h-0 flex-1 items-start justify-center overflow-auto bg-[var(--studio-surface)] p-16">
        {hasFiles ? (
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
              stack={projectFiles.stack}
              files={projectFiles.files}
              designDirection={projectFiles.designDirection}
              className="h-full w-full"
            />
          </div>
        ) : (
          <div className="flex h-full items-center justify-center px-24 text-center">
            <p className="text-[13px] leading-5 text-[var(--studio-muted)]">
              {error ?? (projectFiles.loading ? 'Loading preview…' : 'Preview is not available')}
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
