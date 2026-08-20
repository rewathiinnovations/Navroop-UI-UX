/**
 * The checkpoint card shipped a segmented control where one tab did nothing and
 * its neighbour rewrote the project's files — with the destructive one
 * pre-selected on mount, so the card claimed to be "Previewing" a version
 * nobody had asked for (F-156). Nothing in the component ever branched on
 * `segment`, so "Details" only moved the highlight.
 *
 * A source scan: there is no DOM testing library here, and what was wrong is the
 * shape of the control.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = readFileSync(
  fileURLToPath(new URL('../../components/workspace/CheckpointCard.tsx', import.meta.url)),
  'utf8',
);
/** Comments name the control that went; the code must not still hold it. */
const card = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

describe('the checkpoint card', () => {
  it('has no segmented control and no local segment state', () => {
    expect(card).not.toMatch(/setSegment|'previewing'|Details/);
    expect(card).not.toMatch(/useState/);
  });

  it('offers one explicit action that is not pre-selected', () => {
    // The only write is the caller's `onPreviewCheckpoint`, and it now needs a
    // deliberate click rather than being the tab the card mounts on.
    expect(card).toMatch(/Preview this version/);
    expect(card).toMatch(/onPreviewCheckpoint\(checkpoint\.id\)/);
  });

  it('takes whether it is the previewed version from the caller, not from itself', () => {
    // The workspace owns `previewedVersionId`; a card that tracked its own would
    // keep claiming to be the previewed one after another card took over.
    expect(card).toMatch(/isPreviewing/);
  });
});
