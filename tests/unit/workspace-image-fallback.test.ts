/**
 * F-129: the workspace rendered every stored image as a bare `<img>` with no `onError` and
 * no `loading` attribute. Object storage rows outlive their objects — a purge, a rolled-back
 * upload, an outage — and the browser then draws its broken-image glyph inside an otherwise
 * complete card, which reads as "still loading" rather than "this asset is gone".
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import ImageWithFallback, { imageUnavailable } from '@/components/workspace/ImageWithFallback';
import CheckpointCard from '@/components/workspace/CheckpointCard';
import PresenceAvatars from '@/components/workspace/PresenceAvatars';

/** Every component that renders an image fetched from object storage. */
const CONSUMERS = [
  'components/workspace/AssetsPanel.tsx',
  'components/workspace/VersionHistoryPanel.tsx',
  'components/workspace/CheckpointCard.tsx',
  'components/workspace/PresenceAvatars.tsx',
];

describe('a stored image that fails to load falls back instead of breaking (F-129)', () => {
  it('renders the image with a lazy load hint until it fails', () => {
    const markup = renderToStaticMarkup(
      createElement(ImageWithFallback, {
        src: 'https://storage.example/a.png',
        alt: 'a hero shot',
        width: 800,
        height: 600,
        fallback: createElement('span', null, 'Image unavailable'),
      }),
    );
    expect(markup).toContain('src="https://storage.example/a.png"');
    expect(markup).toContain('alt="a hero shot"');
    expect(markup).toContain('loading="lazy"');
    expect(markup).toContain('width="800"');
    expect(markup).toContain('height="600"');
    expect(markup).not.toContain('Image unavailable');
  });

  it('shows the caller placeholder for the url that failed', () => {
    expect(imageUnavailable('https://storage.example/a.png', 'https://storage.example/a.png')).toBe(
      true,
    );
  });

  it('retries a different url after a failure instead of staying broken', () => {
    expect(imageUnavailable('https://storage.example/b.png', 'https://storage.example/a.png')).toBe(
      false,
    );
    expect(imageUnavailable('https://storage.example/b.png', null)).toBe(false);
  });

  it('handles the error rather than leaving the browser to draw a broken glyph', () => {
    const source = readFileSync('components/workspace/ImageWithFallback.tsx', 'utf8');
    expect(source).toMatch(/onError=/);
  });

  it('routes every workspace stored image through the wrapper', () => {
    for (const path of CONSUMERS) {
      const source = readFileSync(path, 'utf8');
      expect(source, `${path} still renders a bare <img>`).not.toMatch(/<img[\s>]/);
      expect(source, `${path} does not use ImageWithFallback`).toContain('ImageWithFallback');
    }
  });

  it('renders a real consumer both ways: thumbnail present and thumbnail absent', () => {
    const checkpoint = {
      id: 'ck_1',
      label: 'First build',
      createdAt: new Date('2026-08-01T00:00:00.000Z').toISOString(),
    };
    const withThumb = renderToStaticMarkup(
      createElement(CheckpointCard, {
        checkpoint: { ...checkpoint, thumbnailUrl: 'https://storage.example/ck_1.png' },
      }),
    );
    expect(withThumb).toContain('src="https://storage.example/ck_1.png"');
    expect(withThumb).toContain('loading="lazy"');

    // The same placeholder the error path swaps in.
    const withoutThumb = renderToStaticMarkup(createElement(CheckpointCard, { checkpoint }));
    expect(withoutThumb).not.toContain('<img');
    expect(withoutThumb).toContain('Preview');
  });

  it('renders presence avatars with a lazy image and initials without one', () => {
    const viewer = { id: 'u_1', name: 'Ada Lovelace' };
    const withAvatar = renderToStaticMarkup(
      createElement(PresenceAvatars, {
        viewers: [{ ...viewer, avatarUrl: 'https://storage.example/u_1.png' }],
      }),
    );
    expect(withAvatar).toContain('src="https://storage.example/u_1.png"');
    expect(withAvatar).toContain('loading="lazy"');

    const withoutAvatar = renderToStaticMarkup(
      createElement(PresenceAvatars, { viewers: [viewer] }),
    );
    expect(withoutAvatar).not.toContain('<img');
    expect(withoutAvatar).toContain('AL');
  });
});
