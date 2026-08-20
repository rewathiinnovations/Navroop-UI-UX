import { describe, expect, it } from 'vitest';
import {
  attachmentPromptBlock,
  ATTACHMENT_ACCEPT,
  type PromptAttachment,
} from '@/lib/assets/attachment-prompt';

/**
 * F-091: what an image attached in the chat composer is allowed to put into a
 * model prompt.
 *
 * An attachment carries one piece of attacker-controlled text — its filename,
 * which becomes `ProjectAsset.altText`. That value reaches the prompt through
 * `formatAssetManifest`, which flattens it with `sanitizeUntrustedLine`
 * (covered by tests/unit/import-untrusted-prompt.test.ts). This block is the
 * *other* path — the line the composer adds to the user's own message — and it
 * must therefore be built only from values this system produced: the storage
 * URL and the decoded dimensions. Nothing from the file.
 */

const ATTACHMENT: PromptAttachment = {
  url: 'https://cdn.test/projects/p1/assets/abc.webp',
  width: 1440,
  height: 900,
};

describe('attachmentPromptBlock', () => {
  it('is empty when nothing is attached, so a plain message is byte-identical', () => {
    expect(attachmentPromptBlock([])).toBe('');
  });

  it('names each attachment by URL and size', () => {
    const block = attachmentPromptBlock([ATTACHMENT]);
    expect(block).toContain(ATTACHMENT.url);
    expect(block).toContain('1440x900');
  });

  it('tells the model the images already exist rather than to generate them', () => {
    const block = attachmentPromptBlock([ATTACHMENT]);
    expect(block).toMatch(/already uploaded/i);
    expect(block).not.toContain('NEED_IMAGE');
  });

  it('carries no text that came from the attached file', () => {
    // The type has no filename or alt field on purpose; this asserts the
    // rendered block cannot grow one by accident.
    const block = attachmentPromptBlock([
      ATTACHMENT,
      { url: 'https://cdn.test/b.webp', width: 10, height: 20 },
    ]);
    const bodyLines = block.split('\n').filter((line) => line.startsWith('- '));
    expect(bodyLines).toEqual([
      `- ${ATTACHMENT.url} (1440x900)`,
      '- https://cdn.test/b.webp (10x20)',
    ]);
  });

  it('accepts only the four image types the upload pipeline sniffs for', () => {
    // Same set as `sniffImageType` in lib/assets/optimize.ts. A picker that
    // offered PDF or SVG would be a file dialog whose every result is refused.
    expect(ATTACHMENT_ACCEPT.split(',').sort()).toEqual([
      'image/gif',
      'image/jpeg',
      'image/png',
      'image/webp',
    ]);
  });
});
