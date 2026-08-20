/**
 * The Quality → Code & performance panel used to attribute its numbers to a
 * "sandbox environment" that was deleted with the sandbox subsystem, so a user
 * could not reason about how trustworthy they are (F-154). It also shipped
 * `LIVE_MODE_LOCKED_REASON` behind a `liveReason` field no branch can set:
 * `getPreviewStatus` hard-codes `lockedLive = false`.
 *
 * Source scans rather than a rendered panel: there is no DOM testing library
 * here, and the defect is the words themselves.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

function read(relative: string): string {
  return readFileSync(join(ROOT, relative), 'utf8');
}

describe('Quality panel copy', () => {
  it('names no sandbox, because there is none', () => {
    expect(read('components/workspace/CodeAuditPanel.tsx')).not.toMatch(/sandbox/i);
  });

  it('says why the bundle number is empty instead of calling it an estimate', () => {
    // `runBundleMeasure` returns `bundleKb: null` with `ran: false` when there is
    // no runner (lib/audit/bundle.ts), and `performCodeAudit` passes
    // `sandbox = null` unconditionally — so the metric is always "—". Calling it
    // an estimate implied a measurement had happened somewhere.
    const panel = read('components/workspace/CodeAuditPanel.tsx');
    expect(panel).toContain('build runner');
    expect(panel).not.toMatch(/estimates?[.<'"`]/);
  });
});

describe('an unsettable field is not shipped', () => {
  it('nothing carries LIVE_MODE_LOCKED_REASON or liveReason', () => {
    // Comments are stripped: the record of why the field went is worth keeping,
    // and this guard is about what ships.
    const roots = ['lib', 'components', 'app'];
    const offenders: string[] = [];
    for (const root of roots) {
      for (const entry of readdirSync(join(ROOT, root), {
        recursive: true,
        encoding: 'utf8',
      })) {
        if (typeof entry !== 'string' || !/\.tsx?$/.test(entry)) continue;
        const source = read(join(root, entry))
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/\/\/.*$/gm, '');
        if (/LIVE_MODE_LOCKED_REASON|liveReason/.test(source)) {
          offenders.push(`${root}/${entry.replace(/\\/g, '/')}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
