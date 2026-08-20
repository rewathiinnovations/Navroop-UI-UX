'use client';

import { useEffect, useState } from 'react';
import { Copy, ImagePlus, Trash2 } from 'lucide-react';
import ConfirmAction from '@/components/admin/ConfirmAction';
import { EmptyState } from '@/components/shared/ui/empty-state';
import {
  deleteProjectAsset,
  generateProjectImage,
  listProjectAssets,
  searchProjectStock,
  updateProjectAssetAlt,
  uploadProjectAsset,
  type PublicAsset,
} from '@/lib/assets/actions';
import type { GenerateAspect } from '@/lib/assets/generate-image';
import { notify } from '@/lib/notify';

const ASPECTS: Array<{ id: GenerateAspect; label: string }> = [
  { id: '16:9', label: '16:9' },
  { id: '1:1', label: '1:1' },
  { id: '4:5', label: '4:5' },
  { id: '1200x630', label: '1200×630 OG' },
];

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

export default function AssetsPanel({ projectId }: { projectId: string }) {
  const [assets, setAssets] = useState<PublicAsset[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [prompt, setPrompt] = useState('');
  const [stockQuery, setStockQuery] = useState('');
  const [aspect, setAspect] = useState<GenerateAspect>('16:9');
  const [uploadAlt, setUploadAlt] = useState('');
  const [busy, setBusy] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    void listProjectAssets(projectId).then((result) => {
      if (cancelled) return;
      setLoading(false);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setAssets(result.data);
    });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  /**
   * Every asset mutation funnels through here, so success and failure toasts
   * live in one place rather than at each call site.
   */
  const run = async (label: string, done: string, work: () => Promise<PublicAsset | void>) => {
    setBusy(label);
    try {
      const asset = await work();
      if (asset) setAssets((current) => [asset, ...current.filter((row) => row.id !== asset.id)]);
      notify.success(done, { key: `asset-${label}` });
    } catch (caught) {
      notify.error(caught, { key: `asset-${label}` });
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-[var(--studio-bg)]">
      <div className="border-b border-[var(--studio-line)] px-16 py-12">
        <h2 className="text-[14px] font-semibold text-[var(--studio-fg)]">Assets</h2>
        <p className="text-[12px] text-[var(--studio-faint)]">
          Generate, find stock, or upload. Alt text is required.
        </p>
      </div>

      <div className="grid gap-12 border-b border-[var(--studio-line)] px-16 py-12 md:grid-cols-3">
        <div className="space-y-8">
          <label
            className="block text-[12px] font-medium text-[var(--studio-muted)]"
            htmlFor="asset-generate"
          >
            Generate image
          </label>
          <textarea
            id="asset-generate"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            rows={2}
            placeholder="Abstract gradient hero background"
            className="w-full rounded-10 border border-[var(--studio-line)] bg-[var(--studio-surface)] px-10 py-8 text-[13px] text-[var(--studio-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--studio-ring)]"
          />
          <div className="flex flex-wrap gap-6">
            {ASPECTS.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setAspect(item.id)}
                className={`rounded-full px-10 py-4 text-[12px] ${
                  aspect === item.id
                    ? 'bg-[var(--studio-fg)] text-[var(--studio-bg)]'
                    : 'border border-[var(--studio-line)] text-[var(--studio-muted)]'
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            disabled={busy === 'generate'}
            onClick={() =>
              void run('generate', 'Image generated.', async () => {
                const result = await generateProjectImage(projectId, prompt, aspect);
                if (!result.ok) throw new Error(result.error);
                setPrompt('');
                return result.data;
              })
            }
            className="inline-flex h-36 items-center gap-6 rounded-full bg-[var(--studio-fg)] px-12 text-[12px] font-medium text-[var(--studio-bg)] disabled:opacity-50"
          >
            <ImagePlus className="size-14" />
            {busy === 'generate' ? 'Generating…' : 'Generate'}
          </button>
        </div>

        <div className="space-y-8">
          <label
            className="block text-[12px] font-medium text-[var(--studio-muted)]"
            htmlFor="asset-stock"
          >
            Find stock photo
          </label>
          <input
            id="asset-stock"
            value={stockQuery}
            onChange={(event) => setStockQuery(event.target.value)}
            placeholder="Chef in a kitchen"
            className="w-full rounded-10 border border-[var(--studio-line)] bg-[var(--studio-surface)] px-10 py-8 text-[13px] text-[var(--studio-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--studio-ring)]"
          />
          <button
            type="button"
            disabled={busy === 'stock'}
            onClick={() =>
              void run('stock', 'Stock image added.', async () => {
                const result = await searchProjectStock(projectId, stockQuery);
                if (!result.ok) throw new Error(result.error);
                setStockQuery('');
                return result.data;
              })
            }
            className="inline-flex h-36 items-center rounded-full border border-[var(--studio-line-strong)] px-12 text-[12px] font-medium text-[var(--studio-fg)] disabled:opacity-50"
          >
            {busy === 'stock' ? 'Searching…' : 'Find stock'}
          </button>
        </div>

        <div className="space-y-8">
          <label
            className="block text-[12px] font-medium text-[var(--studio-muted)]"
            htmlFor="asset-upload-alt"
          >
            Upload (alt text required)
          </label>
          <input
            id="asset-upload-alt"
            value={uploadAlt}
            onChange={(event) => setUploadAlt(event.target.value)}
            placeholder="Describe the image"
            className="w-full rounded-10 border border-[var(--studio-line)] bg-[var(--studio-surface)] px-10 py-8 text-[13px] text-[var(--studio-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--studio-ring)]"
          />
          <label className="inline-flex h-36 cursor-pointer items-center rounded-full border border-[var(--studio-line-strong)] px-12 text-[12px] font-medium text-[var(--studio-fg)]">
            <input
              type="file"
              accept="image/*"
              className="sr-only"
              disabled={busy === 'upload'}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (!file) return;
                void run('upload', 'Image uploaded.', async () => {
                  const formData = new FormData();
                  formData.set('file', file);
                  formData.set('altText', uploadAlt);
                  const result = await uploadProjectAsset(projectId, formData);
                  if (!result.ok) throw new Error(result.error);
                  setUploadAlt('');
                  return result.data;
                });
              }}
            />
            {busy === 'upload' ? 'Uploading…' : 'Upload'}
          </label>
        </div>
      </div>

      {error && (
        <p className="px-16 py-8 text-[12px] text-[var(--studio-danger)]" role="alert">
          {error}
        </p>
      )}

      <ul className="grid flex-1 auto-rows-min grid-cols-1 gap-12 overflow-y-auto p-16 sm:grid-cols-2 xl:grid-cols-3">
        {loading && (
          <li
            className="col-span-full grid grid-cols-1 gap-12 sm:grid-cols-2 xl:grid-cols-3"
            role="status"
            aria-label="Loading assets"
          >
            {[0, 1, 2].map((key) => (
              <div
                key={key}
                aria-hidden
                className="h-140 animate-pulse rounded-12 bg-[var(--studio-skeleton)]"
              />
            ))}
          </li>
        )}
        {!loading && assets.length === 0 && (
          <li className="col-span-full">
            <EmptyState
              title="No assets yet"
              description="Upload an image or generate one from chat and it will show up here."
            />
          </li>
        )}
        {assets.map((asset) => (
          <li
            key={asset.id}
            className="rounded-12 border border-[var(--studio-line)] bg-[var(--studio-surface)] p-12"
          >
            <div className="mb-10 h-72 overflow-hidden rounded-8 bg-[var(--studio-skeleton)]">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={asset.url} alt={asset.altText} className="size-full object-cover" />
            </div>
            <div className="mb-8 flex items-center justify-between gap-8">
              <span className="rounded-full bg-[var(--studio-bg)] px-8 py-2 text-[11px] text-[var(--studio-muted)]">
                {asset.kind}
              </span>
              <span className="text-[11px] text-[var(--studio-faint)]">
                {asset.width}×{asset.height} · {formatBytes(asset.sizeBytes)}
              </span>
            </div>
            <label className="sr-only" htmlFor={`alt-${asset.id}`}>
              Alt text
            </label>
            <input
              id={`alt-${asset.id}`}
              defaultValue={asset.altText}
              onBlur={(event) => {
                const next = event.target.value.trim();
                if (!next || next === asset.altText) return;
                void updateProjectAssetAlt(projectId, asset.id, next).then((result) => {
                  if (!result.ok) {
                    notify.error(result.error, { key: `asset-alt-${asset.id}` });
                    return;
                  }
                  setAssets((current) =>
                    current.map((row) => (row.id === asset.id ? result.data : row)),
                  );
                  notify.success('Alt text saved.', { key: `asset-alt-${asset.id}` });
                });
              }}
              className="mb-8 w-full rounded-8 border border-[var(--studio-line)] bg-[var(--studio-bg)] px-8 py-6 text-[12px] text-[var(--studio-fg)]"
            />
            <div className="flex gap-8">
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard
                    .writeText(asset.url)
                    .then(() => notify.success('Asset URL copied.', { key: 'asset-copy' }))
                    .catch(() => notify.warning('Could not copy the URL.', { key: 'asset-copy' }));
                }}
                className="inline-flex h-32 items-center gap-4 rounded-full border border-[var(--studio-line)] px-10 text-[11px] text-[var(--studio-fg)]"
              >
                <Copy className="size-12" />
                Copy URL
              </button>
              <ConfirmAction
                label={
                  <span className="inline-flex items-center gap-4">
                    <Trash2 className="size-12" aria-hidden />
                    Delete
                  </span>
                }
                title="Delete this asset?"
                body="It is removed from storage and the library. Pages that reference it may break."
                confirmLabel="Delete"
                busyLabel="Deleting…"
                variant="ghost"
                triggerClassName="min-h-0 h-32 rounded-full border border-[var(--studio-line)] px-10 text-[11px] text-[var(--studio-danger)]"
                onConfirm={async () => {
                  const result = await deleteProjectAsset(projectId, asset.id);
                  if (!result.ok) {
                    notify.error(result.error, { key: `asset-${asset.id}` });
                    return;
                  }
                  setAssets((current) => current.filter((row) => row.id !== asset.id));
                  notify.success('Asset deleted.', { key: `asset-${asset.id}` });
                }}
              />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
