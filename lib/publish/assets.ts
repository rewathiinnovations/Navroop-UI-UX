import { prisma } from '@/lib/db';
import { get } from '@/lib/storage';
import { getStack } from '@/lib/stacks';

/**
 * Project images, as files in the published repo (F-262).
 *
 * A `ProjectAsset` — uploaded, AI-generated, stock, or rehosted from an imported page —
 * is bytes in object storage plus a row holding the URL this app serves them at. Every
 * one of those URLs reaches the generated markup verbatim: `lib/assets/manifest.ts`
 * lists the row's `url` for the model to reuse, and `lib/assets/fulfill.ts` substitutes
 * the same string in for a `NEED_IMAGE:` token. Publish collected only the checkpoint
 * snapshot, so the deployed site asked its own origin for `/uploads/…`, got a 404 from
 * a host that has never heard of the uploads directory, and every image on it was
 * broken while the publish job reported success.
 *
 * On the local driver that URL is app-relative (`/uploads/{key}`), so the bytes have to
 * travel; on the S3 driver it is an absolute URL into a public bucket, which the
 * deployed site can fetch for itself and which no file in the repo could answer anyway.
 * `publishAssetPath` is the whole of that distinction.
 *
 * Referenced-only, on purpose. A project accumulates an asset library — the import
 * rehost alone will add forty — and most of it is never placed. Shipping the library
 * would put megabytes into every commit, and into the push size guards, for images no
 * page asks for.
 */

/**
 * One published image. Bytes cannot ride the git-trees API's inline `content` field:
 * that is a JSON string, so a webp decoded as UTF-8 arrives as replacement characters.
 * `pushFiles` turns this into a base64 blob and references it by sha instead.
 */
export type PublishAssetFile = { base64: string };

/** Absent from storage, versus present but unreadable. Never collapsed into one answer. */
export type PublishAssetFailure = 'missing' | 'unreadable';

/**
 * A referenced image that cannot be published, which fails the publish.
 *
 * Both reasons refuse. `missing` would deploy a page whose `<img>` resolves to nothing,
 * and `unreadable` is a credentials, throttling or network fault that says nothing about
 * whether the object is there — treating it as "no asset" is how a transient S3 error
 * turns into a permanently broken site nobody was told about.
 */
export class PublishAssetError extends Error {
  readonly reason: PublishAssetFailure;
  readonly url: string;
  readonly storageKey: string;

  constructor(reason: PublishAssetFailure, url: string, storageKey: string, cause?: unknown) {
    const detail =
      reason === 'missing'
        ? `its stored file (${storageKey}) is no longer in storage`
        : `storage could not read ${storageKey}: ${cause instanceof Error ? cause.message : String(cause)}`;
    super(
      `This site uses the image ${url}, which cannot be published — ${detail}. Replace the image in the workspace, then publish again.`,
      { cause },
    );
    this.name = 'PublishAssetError';
    this.reason = reason;
    this.url = url;
    this.storageKey = storageKey;
  }
}

/**
 * Where a file has to sit in the repo for the deployed site to serve it at `url`, or null
 * when `url` is not something a file in the repo could answer.
 *
 * Null covers an absolute URL (`https://…`, and `//host/…`, which is remote despite the
 * leading slash) and a `data:` URL — the site already resolves those without help. It
 * also covers a traversal: asset URLs are built from `normalizeKey` output so one cannot
 * occur, and a git tree entry is the last place to find out otherwise.
 */
export function publishAssetPath(publicDir: string, url: string): string | null {
  if (!url.startsWith('/') || url.startsWith('//')) return null;
  const relative = url.slice(1).split(/[?#]/)[0];
  if (!relative || relative.split('/').some((segment) => segment === '..' || segment === '.')) {
    return null;
  }
  return publicDir ? `${publicDir}/${relative}` : relative;
}

export async function collectPublishAssets(input: {
  projectId: string;
  stack: string;
  /** The finished text file set, which is what decides whether an asset is referenced. */
  files: Record<string, string>;
}): Promise<Record<string, PublishAssetFile>> {
  const rows = await prisma.projectAsset.findMany({
    where: { projectId: input.projectId },
    select: { url: true, storageKey: true },
  });
  if (rows.length === 0) return {};

  // Joined rather than searched per file: the question is only whether anything the
  // commit contains names this URL. The separator keeps two files from forming a match
  // across the boundary between them.
  const published = Object.values(input.files).join('\n');
  const publicDir = getStack(input.stack).publicDir;

  const files: Record<string, PublishAssetFile> = {};
  // Sequential, and only for a referenced row: a page places a handful of images, and the
  // whole set is held in memory until the push, so reading them all at once would buy
  // nothing and spike both the object store and this process.
  for (const row of rows) {
    const path = publishAssetPath(publicDir, row.url);
    if (!path || files[path] || !published.includes(row.url)) continue;
    let bytes: Buffer | null;
    try {
      bytes = await get(row.storageKey);
    } catch (error) {
      throw new PublishAssetError('unreadable', row.url, row.storageKey, error);
    }
    if (!bytes) throw new PublishAssetError('missing', row.url, row.storageKey);
    files[path] = { base64: bytes.toString('base64') };
  }
  return files;
}
