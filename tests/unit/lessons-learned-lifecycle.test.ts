import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `.cursor/lessons-learned.md` is not documentation, it is an instruction file: `CLAUDE.md`
 * and the always-on `self-evolving-memory` rule both tell every agent to read it before
 * starting work. So an entry whose subject was deleted does not go quietly stale the way a
 * paragraph in `docs/` does — it actively instructs the next agent to preserve infrastructure
 * that is gone.
 *
 * F-573: thirty-nine entries, zero lifecycle markers, and seventeen `sandbox` mentions plus
 * E2B / Daytona / Modal references all reading as live guidance for the VM subsystem that
 * migration `20260819010000_drop_sandbox_columns` deleted (previews are compiled in the
 * browser now — `components/workspace/BrowserPreview.tsx`). Entries are never deleted: a
 * deleted lesson gets re-learned. They get a marker instead.
 *
 * Three things are checked, and the order matters:
 *
 * 1. The subsystem the markers call dead is *still* dead. If someone brings sandboxes back,
 *    this fails first and says so, rather than letting the marker survive as a new lie.
 * 2. The convention is written down in the file's own header and in the always-on rule set,
 *    so the next writer follows it without being told.
 * 3. Every entry that names the dead subsystem carries a marker, every marker names a
 *    replacement, and no entry lost its original three bullets.
 */

const ROOT = join(__dirname, '..', '..');
const LESSONS = join(ROOT, '.cursor', 'lessons-learned.md');

/** The `Rule going forward:` bullet an entry must keep even after it is marked. */
const ORIGINAL_BULLETS = ['**What happened:**', '**Root cause:**', '**Rule going forward:**'];

/**
 * Deleted with the sandbox subsystem. `sandbox` survives in the tree with exactly one other
 * meaning — the `sandbox` attribute on the browser preview iframe — so that phrase is stripped
 * before matching. Any other use of the word refers to the VM subsystem.
 */
const DEAD_SUBJECT =
  /\bsandbox|\bE2B\b|\bDaytona\b|\bModal\b|visual-edit|INSPECTOR_SCRIPT|lib\/visual-edits/i;
const LIVE_SANDBOX_MEANING = /sandboxed iframe/gi;

const MARKER = /^- \*\*(Superseded|Obsolete) \[(\d{4}-\d{2}-\d{2})\]:\*\* (.{40,})$/m;

/** Header is everything before the first entry; entries are the `### [date] — title` blocks. */
const SECTIONS = readFileSync(LESSONS, 'utf8').split(/\r?\n(?=### \[)/);
const HEADER = SECTIONS[0];
const ENTRIES = SECTIONS.slice(1);

/** First line of an entry, used in every failure message so an offender is identifiable. */
function entryTitle(entry: string) {
  return entry.split(/\r?\n/)[0].trim();
}

describe('lessons-learned lifecycle markers', () => {
  it('the sandbox subsystem the markers call dead is still dead', () => {
    // If any of these come back, the markers below have to be revisited rather than trusted.
    expect(existsSync(join(ROOT, 'lib', 'sandbox'))).toBe(false);
    expect(existsSync(join(ROOT, 'app', '(app)', 'admin', 'sandbox-providers'))).toBe(false);
    expect(
      existsSync(join(ROOT, 'prisma', 'migrations', '20260819010000_drop_sandbox_columns')),
    ).toBe(true);

    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const installed = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    for (const driver of ['@e2b/code-interpreter', 'e2b', '@daytona/sdk', 'modal']) {
      expect(installed, `${driver} is back — recheck the lessons-learned markers`).not.toContain(
        driver,
      );
    }
  });

  it('the visual-edits subsystem the markers call dead is still dead', () => {
    expect(existsSync(join(ROOT, 'lib', 'visual-edits'))).toBe(false);
    expect(existsSync(join(ROOT, 'components', 'workspace', 'VisualEditInspector.tsx'))).toBe(
      false,
    );
    expect(existsSync(join(ROOT, 'components', 'workspace', 'VisualEditsToolbar.tsx'))).toBe(false);
  });

  it('documents the marker convention in its own header', () => {
    expect(HEADER).toMatch(/Superseded \[YYYY-MM-DD\]/);
    expect(HEADER).toMatch(/Obsolete \[YYYY-MM-DD\]/);
    // The two halves of the convention that make a marker useful rather than a riddle.
    expect(HEADER.toLowerCase()).toContain('never deleted');
    expect(HEADER.toLowerCase()).toContain('name a replacement');
  });

  it('makes the convention discoverable from the always-on rule set', () => {
    const rule = readFileSync(join(ROOT, '.cursor', 'rules', 'keep-cursor-current.mdc'), 'utf8');
    expect(rule).toMatch(/alwaysApply: true/);
    expect(rule).toContain('.cursor/lessons-learned.md');
    expect(rule).toMatch(/Superseded/);
    expect(rule).toMatch(/Obsolete/);

    const claude = readFileSync(join(ROOT, 'CLAUDE.md'), 'utf8');
    expect(claude).toMatch(/Superseded/);
    expect(claude).toMatch(/Obsolete/);
  });

  it('marks every entry whose subject the sandbox removal deleted', () => {
    const unmarked = ENTRIES.filter((entry) =>
      DEAD_SUBJECT.test(entry.replace(LIVE_SANDBOX_MEANING, '')),
    )
      .filter((entry) => !MARKER.test(entry))
      .map(entryTitle);
    expect(unmarked).toEqual([]);
  });

  it('never marks an entry whose subject is still in the tree', () => {
    const wronglyMarked = ENTRIES.filter(
      (entry) => !DEAD_SUBJECT.test(entry.replace(LIVE_SANDBOX_MEANING, '')),
    )
      .filter((entry) => MARKER.test(entry))
      .map(entryTitle);
    expect(wronglyMarked).toEqual([]);
  });

  it('keeps every entry and every original bullet', () => {
    // Thirty-nine at the time of F-573. Entries are appended, never removed.
    expect(ENTRIES.length).toBeGreaterThanOrEqual(39);
    const truncated = ENTRIES.filter(
      (entry) => !ORIGINAL_BULLETS.every((bullet) => entry.includes(bullet)),
    ).map(entryTitle);
    expect(truncated).toEqual([]);
  });

  it('accepts only one marker per entry, dated and naming a replacement', () => {
    const offenders: string[] = [];
    for (const entry of ENTRIES) {
      const markers = entry
        .split(/\r?\n/)
        .filter((line) => /^- \*\*(Superseded|Obsolete)\b/.test(line));
      if (markers.length === 0) continue;
      if (markers.length > 1) {
        offenders.push(`${entryTitle(entry)} — ${markers.length} markers`);
        continue;
      }
      if (!MARKER.test(markers[0])) {
        offenders.push(`${entryTitle(entry)} — malformed or too terse: ${markers[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('puts the marker last, so the original entry reads unchanged first', () => {
    const misplaced = ENTRIES.filter((entry) => MARKER.test(entry))
      .filter((entry) => {
        const lines = entry.split(/\r?\n/).filter((line) => line.trim().length > 0);
        return !/^- \*\*(Superseded|Obsolete)\b/.test(lines[lines.length - 1]);
      })
      .map(entryTitle);
    expect(misplaced).toEqual([]);
  });
});
