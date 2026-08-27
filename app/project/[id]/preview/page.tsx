'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { cn } from '@/utils/cn';
import PreviewDeviceToolbar from '@/components/workspace/PreviewDeviceToolbar';
import {
  formatPreviewSize,
  getPreviewDevice,
  rotateDeviceSize,
  type PreviewDeviceKey,
} from '@/lib/preview/devices';

/**
 * Standalone preview for the header's "Open in new tab". The served build is
 * model-authored JavaScript, so it renders inside a sandboxed iframe here rather
 * than running top-level on the app origin with the viewer's session (F-140).
 * The device toolbar is the same control the workspace Preview tab uses.
 */
export default function ProjectPreviewPage() {
  const params = useParams();
  const projectId = typeof params.id === 'string' ? params.id : null;
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [device, setDevice] = useState<PreviewDeviceKey>('desktop');
  const [rotated, setRotated] = useState(false);

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`/api/projects/${projectId}/preview`);
        if (cancelled) return;
        const data = (await response.json().catch(() => ({}))) as {
          previewUrl?: string | null;
          error?: string;
        };
        if (!response.ok || !data.previewUrl) {
          setError(data.error || 'Preview is not available');
          return;
        }
        setPreviewUrl(data.previewUrl);
      } catch {
        if (!cancelled) setError('Could not load the preview');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

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
        {previewUrl ? (
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
              src={previewUrl}
              title="Project preview"
              className="h-full w-full border-0 bg-white"
              sandbox="allow-scripts allow-forms allow-modals allow-popups"
            />
          </div>
        ) : (
          <div className="flex h-full items-center justify-center px-24 text-center">
            <p className="text-[13px] leading-5 text-[var(--studio-muted)]">
              {error ?? 'Loading preview…'}
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
