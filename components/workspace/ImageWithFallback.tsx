'use client';

import { useState } from 'react';
import type { ReactNode } from 'react';

/**
 * A failure is remembered against the URL that produced it rather than as a sticky boolean:
 * a list re-render hands the same element a different asset, and that new URL has to be
 * attempted instead of inheriting the previous one's failure.
 */
export function imageUnavailable(src: string, failedSrc: string | null) {
  return failedSrc === src;
}

/**
 * F-129: every stored image in the workspace is fetched straight from object storage, where
 * a row can outlive its object — a purge, a rolled-back upload, an outage. A bare `<img>`
 * then draws the browser's broken-image glyph inside an otherwise complete card, which reads
 * as "still loading" forever. On error this swaps in the caller's own placeholder, the same
 * one an absent URL already shows, so the card says the asset is gone.
 *
 * `next/image` is not an option for these: `next.config.ts` allowlists only
 * `www.google.com` and `storage.googleapis.com`, and the storage public host is
 * operator-configured at runtime.
 */
export default function ImageWithFallback({
  src,
  alt,
  className,
  width,
  height,
  fallback,
}: {
  src: string;
  alt: string;
  className?: string;
  /** Intrinsic pixel size, when it is actually known. Omitted rather than guessed. */
  width?: number;
  height?: number;
  fallback: ReactNode;
}) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);

  if (imageUnavailable(src, failedSrc)) return <>{fallback}</>;

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={alt}
      className={className}
      width={width}
      height={height}
      loading="lazy"
      decoding="async"
      onError={() => setFailedSrc(src)}
    />
  );
}
