import { describe, expect, it } from 'vitest';
import {
  PACKAGE_LOOKBEHIND,
  StreamedPackageTracker,
} from '@/lib/generation/stream-package-tracker';

/**
 * F-024. The generate route carried its package-tag scan in a `tagBuffer` trimmed
 * with `searchText.substring(Math.max(0, lastIndex - 50))`, where `lastIndex`
 * only ever advanced when a `<package>` tag matched. On an initial build, and on
 * every edit whose reply has no package tag — the normal case — `lastIndex` stayed
 * `0`, so `substring(0)` handed the whole string back and the buffer became a
 * second full copy of the reply. On edits the regex then re-scanned that
 * ever-growing buffer on every chunk: O(n²) over a reply that can reach ~500 KB.
 *
 * The property that matters is that bounding the carry-over changes nothing about
 * what is detected. Each case feeds the same reply at a different chunk size and
 * compares against one scan of the whole text.
 */
/** A reply with prose, files, and package tags spread through it. */
function longReply(packages: string[]) {
  const prose = 'The layout needs a shared header, so I am rewriting the root file. ';
  const parts: string[] = [];
  for (let index = 0; index < 400; index += 1) {
    parts.push(prose.repeat(3));
    if (index % 40 === 0 && packages.length > 0) {
      parts.push(`<package>${packages[(index / 40) % packages.length]}</package>`);
    }
    parts.push(`<file path="app/section-${index}.tsx">export default function S() {}</file>\n`);
  }
  return parts.join('');
}

function chunk(text: string, size: number) {
  const chunks: string[] = [];
  for (let at = 0; at < text.length; at += size) chunks.push(text.slice(at, at + size));
  return chunks;
}

function feed(text: string, size: number) {
  const tracker = new StreamedPackageTracker();
  const found: string[] = [];
  let peakBuffer = 0;
  for (const part of chunk(text, size)) {
    found.push(...tracker.push(part));
    peakBuffer = Math.max(peakBuffer, tracker.bufferLength);
  }
  return { found, peakBuffer };
}

const PACKAGES = ['framer-motion', 'zod', 'clsx', 'date-fns', 'react-hook-form'];
const REPLY = longReply(PACKAGES);
/** One scan of the whole reply: what any chunking must reproduce exactly. */
const EXPECTED = [...REPLY.matchAll(/<package>([^<]+)<\/package>/g)].map((match) =>
  match[1].trim(),
);

// 1 splits every tag; the rest straddle boundaries at unrelated offsets; the last
// is one chunk, the shape a fast provider actually sends.
const CHUNK_SIZES = [1, 2, 3, 7, 13, 64, 511, 512, 513, 997, REPLY.length];

describe('StreamedPackageTracker', () => {
  it('has a reply long enough for the quadratic case to matter', () => {
    expect(REPLY.length).toBeGreaterThan(100_000);
    expect(EXPECTED.length).toBe(10);
  });

  it.each(CHUNK_SIZES)('detects exactly the same tags at chunk size %i', (size) => {
    expect(feed(REPLY, size).found).toEqual(EXPECTED);
  });

  it.each(CHUNK_SIZES)('never retains more than the lookbehind at chunk size %i', (size) => {
    const { peakBuffer } = feed(REPLY, size);
    expect(peakBuffer).toBeLessThanOrEqual(PACKAGE_LOOKBEHIND);
    // The bug was a buffer that tracked the reply. Anything near the reply length
    // is that bug back, whatever the constant says.
    expect(peakBuffer).toBeLessThan(REPLY.length / 100);
  });

  // The finding's primary case: "all initial builds, and every edit whose reply has
  // no `<package>` tag, which is the normal case". With nothing ever matching, the
  // old `substring(Math.max(0, lastIndex - 50))` returned the whole string every
  // time — measured at 108,690 of 108,690 bytes on this very reply.
  it.each(CHUNK_SIZES)('stays bounded on a reply with no package tag at all (%i)', (size) => {
    const tagFree = REPLY.replace(/<package>[^<]+<\/package>/g, '');
    const { found, peakBuffer } = feed(tagFree, size);
    expect(found).toEqual([]);
    expect(peakBuffer).toBeLessThanOrEqual(PACKAGE_LOOKBEHIND);
  });

  it('reports a tag split across two chunks once, not twice', () => {
    const tracker = new StreamedPackageTracker();
    expect(tracker.push('install <pack')).toEqual([]);
    expect(tracker.push('age>zod</package> and go')).toEqual(['zod']);
    expect(tracker.push(' nothing more here')).toEqual([]);
  });

  it('carries a tag that straddles a chunk after a long unmatched run', () => {
    const tracker = new StreamedPackageTracker();
    tracker.push('x'.repeat(PACKAGE_LOOKBEHIND * 4));
    expect(tracker.bufferLength).toBeLessThanOrEqual(PACKAGE_LOOKBEHIND);
    expect(tracker.push('<package>framer-motion</pack')).toEqual([]);
    expect(tracker.push('age>')).toEqual(['framer-motion']);
  });

  it('does not re-report a tag it already consumed', () => {
    const tracker = new StreamedPackageTracker();
    expect(tracker.push('<package>zod</package>')).toEqual(['zod']);
    expect(tracker.push('more prose')).toEqual([]);
    expect(tracker.push('<package>zod</package>')).toEqual(['zod']);
  });

  it('trims the name and skips an empty tag, the way the route did', () => {
    const tracker = new StreamedPackageTracker();
    expect(tracker.push('<package>  clsx  </package><package> </package>')).toEqual(['clsx']);
  });

  it('holds a long package name across a split rather than losing it', () => {
    const name = `@scope/${'a'.repeat(180)}`;
    const tracker = new StreamedPackageTracker();
    tracker.push(`<package>${name}`);
    expect(tracker.push('</package>')).toEqual([name]);
  });
});
