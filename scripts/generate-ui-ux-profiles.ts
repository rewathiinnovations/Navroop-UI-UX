/**
 * One-time generator: distills the ui-ux-pro-max skill's CSV research data into a
 * typed, vendored profile module the app can import at runtime.
 *
 * The skill data lives in `.cursor/skills/ui-ux-pro-max/data/*.csv` — a path that
 * does not exist on a deployed server (only in a dev checkout), and the skill's own
 * `search.py` needs Python, which is not guaranteed on the server either. So the
 * breadth is captured here, once, into `lib/ui-ux-pro-max/profiles.ts`, and runtime
 * reads that module — never the CSV, never Python.
 *
 * Re-run it whenever the skill's CSVs change:
 *
 *   node ./node_modules/tsx/dist/cli.mjs scripts/generate-ui-ux-profiles.ts
 *
 * That is the direct-binary form every script here uses; the Verify / release
 * section of AGENTS.md says why no other runner is safe in an agent shell.
 *
 * It is a graph root in `knip.json`'s `entry` list. A generator that produces a
 * checked-in artefact has no importer by construction, so without that entry knip
 * reports it as dead code and the next tidy-up wave deletes the only thing that
 * can regenerate `lib/ui-ux-pro-max/profiles.ts`.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const DATA_DIR = join(
  repoRoot,
  '.cursor',
  'skills',
  'ui-ux-pro-max',
  'data',
);
const OUT_FILE = join(repoRoot, 'lib', 'ui-ux-pro-max', 'profiles.ts');

function readCsv(name: string): Record<string, string>[] {
  const raw = readFileSync(join(DATA_DIR, name), 'utf8');
  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const headers = lines[0].split(',').map((h) => h.trim());
  return lines.slice(1).map((line) => {
    // Fields contain commas inside quotes; parse with a tiny finite state machine.
    const cells: string[] = [];
    let current = '';
    let inQuotes = false;
    for (const ch of line) {
      if (ch === '"') {
        inQuotes = !inQuotes;
      } else if (ch === ',' && !inQuotes) {
        cells.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
    cells.push(current);
    const row: Record<string, string> = {};
    headers.forEach((h, i) => {
      row[h] = (cells[i] ?? '').trim();
    });
    return row;
  });
}

/** "✓ Full" / "◐ Partial" -> 'light' | 'dark' | 'either'. */
function surfaceFromMode(light: string, dark: string): 'light' | 'dark' | 'either' {
  const canLight = light.startsWith('✓');
  const canDark = dark.startsWith('✓');
  if (canLight && canDark) return 'either';
  if (canDark) return 'dark';
  return 'light';
}

function cellList(value: string): string[] {
  return value
    .split(/[;,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function styleProfilesFromCsv(rows: Record<string, string>[]) {
  return rows.map((row, i) => ({
    // Stable id derived from row number so a re-ordered CSV keeps names stable.
    name: row['Style Category'] || `Style ${i + 1}`,
    type: row['Type'] || '',
    keywords: cellList(row['Keywords']),
    surface: surfaceFromMode(row['Light Mode ✓'] || '', row['Dark Mode ✓'] || ''),
    prompt: [row['Effects & Animation'], row['Best For']].filter(Boolean).join(' '),
    tokens: row['CSS/Technical Keywords'],
    avoid: row['Do Not Use For'] || '',
    bestFor: row['Best For'] || '',
    performance: row['Performance'] || '',
    accessibility: row['Accessibility'] || '',
    mobile: row['Mobile-Friendly'] || '',
    conversion: row['Conversion-Focused'] || '',
  }));
}

function typeProfilesFromCsv(rows: Record<string, string>[]) {
  return rows.map((row, i) => ({
    name: row['Font Pairing Name'] || `Pairing ${i + 1}`,
    keywords: cellList(row['Mood/Style Keywords']),
    heading: row['Heading Font'] || 'Inter',
    body: row['Body Font'] || 'Inter',
    // The CSV stores the whole family=... string; keep only the query part so the
    // builder's "Import once" line stays short.
    importUrl: row['Google Fonts URL'] || '',
    notes: row['Notes'] || '',
  }));
}

function landingProfilesFromCsv(rows: Record<string, string>[]) {
  return rows.map((row, i) => ({
    name: row['Pattern Name'] || `Pattern ${i + 1}`,
    keywords: cellList(row['Keywords']),
    sections: row['Section Order'] || '',
    cta: row['Primary CTA Placement'] || '',
  }));
}

/**
 * `products.csv` and `ux-guidelines.csv` are deliberately not vendored.
 *
 * They were emitted here once, as `PRODUCT_PROFILES` and `UX_RULES`, and nothing
 * ever imported them: a third of the generated module — about 118 KB — sat in the
 * tree as the only evidence of a feature that was never wired, and the `UX_RULES`
 * name collided with the hand-distilled prose bar `build-design-brief.ts` renders,
 * so a reader could not tell which one the brief used. Emit only what
 * `build-design-brief.ts` selects from — styles, typefaces, landing patterns — and
 * a future consumer adds its table back here alongside the code that reads it,
 * rather than the other way round.
 *
 * The reasoning per table is in `lib/ui-ux-pro-max/build-design-brief.ts`: the UX
 * bar is prose the brief prints, not 99 do/don't rows to inline into every prompt,
 * and a product-type table would be a second selector competing with the keyword
 * scorer for the same three slots with no rule for which wins.
 */
const styles = styleProfilesFromCsv(readCsv('styles.csv'));
const typography = typeProfilesFromCsv(readCsv('typography.csv'));
const landings = landingProfilesFromCsv(readCsv('landing.csv'));

const output = `/**
 * Vendored ui-ux-pro-max profiles, generated from the skill's CSV research data.
 * DO NOT EDIT BY HAND — run \`node ./node_modules/tsx/dist/cli.mjs scripts/generate-ui-ux-profiles.ts\`.
 * The skill data lives in .cursor/skills/ui-ux-pro-max/data/*.csv, which is not on a
 * deployed server and whose search.py needs Python. Keeping the breadth here lets the
 * runtime pick the right style without a CLI subprocess or a path that may not exist.
 */
export type SurfaceKind = 'light' | 'dark' | 'either';

export type StyleProfile = {
  name: string;
  type: string;
  keywords: string[];
  surface: SurfaceKind;
  prompt: string;
  tokens: string;
  avoid: string;
  bestFor: string;
  performance: string;
  accessibility: string;
  mobile: string;
  conversion: string;
};

export type TypeProfile = {
  name: string;
  keywords: string[];
  heading: string;
  body: string;
  importUrl: string;
  notes: string;
};

export type LandingProfile = {
  name: string;
  keywords: string[];
  sections: string;
  cta: string;
};

export const STYLE_PROFILES: StyleProfile[] = ${JSON.stringify(styles, null, 2)};

export const TYPEFACE_PROFILES: TypeProfile[] = ${JSON.stringify(typography, null, 2)};

export const LANDING_PROFILES: LandingProfile[] = ${JSON.stringify(landings, null, 2)};
`;

mkdirSync(dirname(OUT_FILE), { recursive: true });
writeFileSync(OUT_FILE, output, 'utf8');
console.log(
  `Wrote ${OUT_FILE}: ${styles.length} styles, ${typography.length} typefaces, ${landings.length} landings.`,
);
