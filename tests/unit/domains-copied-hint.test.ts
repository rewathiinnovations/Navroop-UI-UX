/**
 * The Domains tab's "Copied" hint was set and never cleared, and it was not keyed
 * to anything: one click put the word under *every* domain card and left it there
 * for the life of the page (F-155). `PublishPanel` already does this correctly
 * with a 1.5 s timeout.
 *
 * A source scan, because there is no DOM testing library here and the defect is
 * a missing reset: the two properties that make the hint honest are that it is
 * compared against the row it belongs to, and that something clears it.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const panel = readFileSync(
  fileURLToPath(new URL('../../components/workspace/DomainsPanel.tsx', import.meta.url)),
  'utf8',
);

describe('the Domains "Copied" hint', () => {
  it('is rendered only for the row that was copied', () => {
    expect(panel).toMatch(/copied === domain\.id/);
    // The old render was `{copied ? <span>Copied</span> : null}` — truthy for
    // every card at once.
    expect(panel).not.toMatch(/\{copied \?/);
  });

  it('is cleared on a timer, so it never outlives the action', () => {
    expect(panel).toMatch(/setTimeout\(\(\) => setCopied\(''\), \d+\)/);
  });
});
