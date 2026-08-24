import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { VERIFY_STEPS } from '@/lib/verify/orchestrator';

/**
 * Documentation contracts that drifted silently and cost real money.
 *
 * `docs/e2e-test-and-fix-prompt.md` was 659 lines written to be pasted into an agent verbatim
 * (F-531). It mandated `pnpm exec`, started a dev server on the wrong port, and told the agent to
 * stub ten API routes and visit an admin page that the sandbox removal had deleted — so one paste
 * armed a `node_modules` purge and spent a live-generation budget against endpoints that 404.
 * Prose cannot be typechecked, but the three claims that actually caused harm can be: a command
 * form, an endpoint list, and a freshness marker.
 *
 * `verifyDepsBeforeRun: false` (F-534) and `PREVIEW_PASSWORD` (F-543) are the opposite failure —
 * load-bearing configuration and a whole security control that appeared in no document at all.
 * Both assertions are derived from the code, so they go red when the code changes and the docs do
 * not, which is the only direction that matters.
 *
 * The rest of this file is the mechanism F-551 asked for: the doc set said `npm run verify` in a
 * pnpm-only repo, stated three different wrong coverage floors, pointed the security-override
 * fixer at a file pnpm does not read, named four stack prompts that do not exist, and described
 * the photo pipeline as "Unsplash stock" while a whole image worker and a keyless Openverse
 * fallback went unmentioned. Every assertion below reads the number, path, key or list out of the
 * source and compares, so the doc goes red when the code moves — never the other way round.
 *
 * Two of those assertions were themselves wrong, in opposite directions, and both are fixed here.
 * The `npm run verify` check used a bare `/npm run verify/`, which matches the tail of every
 * legitimate `pnpm run verify` — fifteen false offenders, i.e. a red gate nobody could act on. The
 * `pnpm.overrides` check clipped each line to 120 characters *before* testing it for a negation, so
 * `**Not `pnpm.overrides` in `package.json`**` — the correction itself — was reported as the
 * offence, because the "Not" sat past the cut. A doc check that cries wolf gets deleted, so the
 * escape hatch is now the negation in the same clause and the full line is what gets tested.
 */

const ROOT = process.cwd();
const E2E_BRIEF = join(ROOT, 'docs', 'e2e-test-and-fix-prompt.md');

/**
 * Every scan in this file reads through here, newline-normalised.
 *
 * `core.autocrlf=true` and a `.gitattributes` that pins only `Dockerfile`, `*.sh`
 * and `docker-entrypoint.mjs` to LF mean these docs arrive CRLF in a fresh Windows
 * checkout. A `split('\n\n')` paragraph probe then never splits, so a scan meant to
 * read one block silently reads the rest of the file instead — which is how the
 * verify-gate enumeration check started matching numbered lists from unrelated
 * sections. Normalising once at the read removes the whole class.
 */
const readText = (...parts: string[]) =>
  readFileSync(isAbsolute(parts[0]) ? join(...parts) : join(ROOT, ...parts), 'utf8').replace(
    /\r\n/g,
    '\n',
  );

/** Binaries the repo invokes as `node ./node_modules/…`; `pnpm exec <binary>` is the banned form. */
const BINARIES = ['tsc', 'tsx', 'eslint', 'vitest', 'prisma', 'playwright', 'next'];

/** Every prose document an agent or operator is expected to trust. */
const DOC_FILES = [
  'AGENTS.md',
  'CLAUDE.md',
  'README.md',
  '.cursor/README.md',
  '.cursor/lessons-learned.md',
  ...readdirSync(join(ROOT, '.cursor', 'rules')).map((file) => `.cursor/rules/${file}`),
  ...readdirSync(join(ROOT, 'docs'))
    .filter((file) => file.endsWith('.md'))
    .map((file) => `docs/${file}`),
];

/**
 * The documents an operator configures credentials and settings from. Setting keys are only
 * checked here, for two reasons: the comparison write-ups (`codegen-vs-open-lovable.md`)
 * deliberately quote settings that have since been deleted, as history, and nobody configures
 * anything from them; and `AGENTS.md` is an agent map rather than a deployment guide — it currently
 * carries one stale key (`ai.primaryProvider`, from an overlay that only ever shipped
 * `AI_PRIMARY_MODEL`) which is reported separately, outside this change's scope.
 */
const CREDENTIAL_DOCS = [
  'README.md',
  '.cursor/README.md',
  'docs/coolify.md',
  'docs/release.md',
  'docs/deployment.md',
];

/**
 * A lessons-learned entry is the record of an incident, and its first two bullets recount what
 * actually ran and why it broke — naming the banned form verbatim is the entire point of the
 * entry. Only `**Rule going forward:**` prescribes, so only that bullet is held to the
 * invocation bans below. Without this the eight entries that exist *because* `npm install` and
 * `pnpm exec` misfired are reported as the documents recommending them, which is backwards: the
 * ban is downstream of the incident, so the incident cannot be evidence against it.
 *
 * Deliberately narrower than the negation hatch. It exempts the two narration bullets and
 * nothing else — a stale instruction in `**Rule going forward:**` still fails, which is how
 * the `pnpm.overrides` correction below was caught.
 */
const NARRATION = /^\s*-\s*\*\*(?:What happened|Root cause):\*\*/;

const LESSONS = '.cursor/lessons-learned.md';

/**
 * The lessons log never deletes an entry: one whose subject is gone gets a dated
 * `**Superseded**` / `**Obsolete**` marker instead, and the always-on convention states that an
 * entry with no marker is a live instruction. The converse is what this file needs — a *marked*
 * entry has been declared not-live, so the commands inside it are a record of what used to be
 * advised, not a document advising them now. `tests/unit/lessons-learned-lifecycle.test.ts` owns
 * the marker format and pins it to one per entry, last, naming its replacement.
 *
 * Without this the two tests contradict each other: the lifecycle test forbids rewriting a
 * superseded bullet, and this one demands the superseded bullet stop saying what it said.
 */
const HISTORICAL_LINES = (() => {
  const lines = readText(LESSONS).split('\n');
  const marked = new Set<number>();
  let start = 0;
  const flush = (end: number) => {
    if (lines.slice(start, end).some((line) => /^- \*\*(?:Superseded|Obsolete) \[/.test(line))) {
      for (let index = start; index < end; index += 1) marked.add(index);
    }
  };
  lines.forEach((line, index) => {
    if (line.startsWith('### [')) {
      flush(index);
      start = index;
    }
  });
  flush(lines.length);
  return marked;
})();

/** True for a line inside a lessons entry that a marker has already retired. */
function historical(rel: string, index: number) {
  return rel === LESSONS && HISTORICAL_LINES.has(index);
}

/**
 * `{ where, text }` for every line matching `pattern`, across `files`. `pattern` must not be
 * global. Incident narration is skipped — see `NARRATION`.
 */
function linesMatching(files: string[], pattern: RegExp) {
  const hits: { where: string; text: string }[] = [];
  for (const rel of files) {
    readText(rel)
      .split('\n')
      .forEach((line, index) => {
        if (NARRATION.test(line) || historical(rel, index)) return;
        if (pattern.test(line)) hits.push({ where: `${rel}:${index + 1}`, text: line });
      });
  }
  return hits;
}

/** Readable failure output. The full line is kept above; only the message is clipped. */
function report(hits: { where: string; text: string }[]) {
  return hits.map((hit) => `${hit.where} ${hit.text.trim().slice(0, 120)}`);
}

/**
 * A document may name a banned form in order to ban it, so mentions need an escape hatch — but a
 * whole-line one is worthless here. The Verify/release bullets are single 900-character lines full
 * of the word "never", so exempting a line because it contains a prohibition exempts every
 * invocation printed on it; and clipping the line to 120 characters before testing it fails the
 * opposite way, reporting `**Not `pnpm.overrides` in `package.json`**` as an offender because the
 * negation sits past the cut. The hatch is therefore the negation that precedes the mention in the
 * same clause: same sentence, within ~72 characters.
 */
const NEGATION =
  /\b(?:not|never|no|nothing|don't|do not|instead of|rather than|forbid\w*|banned|only|avoid)\b[^.!?\n]{0,72}$/i;

/**
 * Every occurrence of `pattern` (global) that no negation in its own clause disowns, skipping
 * incident narration — see `NARRATION`.
 */
function unnegatedMentions(files: string[], pattern: RegExp) {
  const offenders: string[] = [];
  for (const rel of files) {
    readText(rel)
      .split('\n')
      .forEach((line, index) => {
        if (NARRATION.test(line) || historical(rel, index)) return;
        for (const hit of line.matchAll(pattern)) {
          if (NEGATION.test(line.slice(0, hit.index))) continue;
          offenders.push(`${rel}:${index + 1} "${hit[0]}" in: ${line.trim().slice(0, 100)}`);
        }
      });
  }
  return offenders;
}

function apiRouteExists(path: string) {
  // Only the literal head has to resolve: past a dynamic (`[id]`) or wildcard segment nothing can
  // be checked. A Playwright glob keeps its stars (`**/api/create-ai-sandbox**`), so strip those
  // before comparing — otherwise every dead endpoint written as a route pattern escapes the check.
  let dir = join(ROOT, 'app', 'api');
  for (const raw of path.replace(/^\/api\//, '').split('/')) {
    const segment = raw.replaceAll('*', '');
    if (!segment || raw.startsWith('[')) return true;
    const next = join(dir, segment);
    if (!existsSync(next)) return false;
    dir = next;
  }
  return true;
}

describe('docs accuracy', () => {
  it('keeps the e2e brief off `pnpm exec <binary>`', () => {
    // Naming the form to forbid it is fine; issuing it is not. `pnpm exec` runs pnpm's
    // dependency-status check, and the abort an agent shell sees is a `node_modules` purge in a
    // human terminal (AGENTS.md, Verify/release).
    const offenders = readText(E2E_BRIEF)
      .split('\n')
      .filter((line) => BINARIES.some((binary) => line.includes(`pnpm exec ${binary}`)));
    expect(offenders, 'the e2e brief issues a `pnpm exec <binary>` command').toEqual([]);
  });

  it('names only API routes that exist in the e2e brief', () => {
    const text = readText(E2E_BRIEF);
    const named = [...text.matchAll(/\/api\/[a-z0-9\-[\]/*]+/gi)].map((row) => row[0]);
    const missing = [...new Set(named)].filter((path) => !apiRouteExists(path));
    expect(missing, 'the e2e brief drives API routes that do not exist').toEqual([]);
  });

  it('gives the e2e brief an owner and a freshness marker', () => {
    // F-575: it is an executable artefact. Without a date, "is this still true?" has no answer,
    // which is how the 659-line version survived the subsystem it described.
    const text = readText(E2E_BRIEF);
    expect(text).toMatch(/^- Owner: /m);
    expect(text).toMatch(/Verified against code on \*\*\d{4}-\d{2}-\d{2}\*\*/);
  });

  it('documents `verifyDepsBeforeRun` wherever the workspace sets it', () => {
    // Four documents and a git hook describe the purge this setting suppresses. If the setting is
    // present, the document carrying that prose has to say so; otherwise every reader concludes the
    // check still fires (F-534).
    const workspace = readText('pnpm-workspace.yaml');
    if (!workspace.includes('verifyDepsBeforeRun')) return;
    const agents = readText('AGENTS.md');
    expect(agents).toContain('verifyDepsBeforeRun');
    expect(agents).toContain('pnpm exec');
  });

  it('documents PREVIEW_PASSWORD while the publish code writes it', () => {
    // An undocumented security control with a two-store invariant: the bcrypt hash on
    // `Deployment.passwordHash` and the plaintext on the Coolify application (F-543). An operator
    // who "cleans up" the env var changes a client preview's access posture.
    const publishDir = join(ROOT, 'lib', 'publish');
    const referenced = readdirSync(publishDir).some((file) =>
      readText(publishDir, file).includes('PREVIEW_PASSWORD'),
    );
    if (!referenced) return;
    for (const file of ['AGENTS.md', '.cursor/README.md', 'docs/coolify.md']) {
      expect(readText(file), `${file} does not mention PREVIEW_PASSWORD`).toContain(
        'PREVIEW_PASSWORD',
      );
    }
  });

  it('offers no npm or yarn invocation as a way to run this repo', () => {
    // F-527/F-528/F-529. `package.json` pins pnpm and the lockfile is `pnpm-lock.yaml`; running a
    // script through npm resolves `node_modules` differently and writes `package-lock.json`, which
    // is a logged incident (`.cursor/lessons-learned.md`). `stack.mdc` said `npm run db:migrate`,
    // `README.md` opened with `pnpm install  # or npm install / yarn install`, and `AGENTS.md` and
    // `docs/release.md` both offered `pnpm run verify` / `npm run verify` as equals. The lookbehind
    // is load-bearing: `\b` finds no boundary inside `pnpm`, but a bare `/npm run verify/` matches
    // the tail of every legitimate `pnpm run verify`, which is how this assertion managed to be
    // simultaneously too loose (whole-line prohibition hatch) and too strict (fifteen false hits).
    expect(JSON.parse(readText('package.json')).packageManager).toMatch(/^pnpm@/);
    expect(
      unnegatedMentions(DOC_FILES, /(?<![\w.-])(?:npm|yarn) (?:run|install|add|exec|ci)\b/g),
      'a document offers npm/yarn as a way to run this repo',
    ).toEqual([]);
  });

  it('issues no `pnpm exec <binary>` command in any document', () => {
    // F-530. `release.md` carries the "never `pnpm exec`" section and then printed
    // `pnpm exec tsx scripts/rollback.ts` seventy lines later — during a rollback, i.e. with
    // production already broken. The hooks' form is `node ./node_modules/tsx/dist/cli.mjs`.
    // No negation hatch: the prohibitions in prose write `pnpm exec <tool>`, never a real binary,
    // so any document naming one is issuing the command rather than banning it.
    const banned = new RegExp(`pnpm exec (?:${BINARIES.join('|')})\\b`);
    expect(
      report(linesMatching(DOC_FILES, banned)),
      'a document issues `pnpm exec <binary>`',
    ).toEqual([]);
  });

  it('runs every repo script through the hooks\u2019 direct binary', () => {
    // F-644, and the other half of F-530. One command had three written forms: `AGENTS.md` said
    // `npx tsx scripts/restore-db.ts`, `README.md` said the same, and `docs/release.md` printed
    // the bare script path with no runner. It is read once — mid-incident, with production down —
    // so the copy-pasteable form has to be the one the hooks use. `npx` is banned here for the
    // same reason as `pnpm exec`: it resolves and may fetch, and neither hook uses it.
    expect(
      unnegatedMentions(DOC_FILES, /(?:npx|pnpm exec) [\w@./-]+ (?:\.\/)?scripts\//g),
      'a document runs a repo script through npx or pnpm exec',
    ).toEqual([]);
  });

  it('states no coverage floor that disagrees with vitest.config.ts', () => {
    // F-532: three documents stated three different floors, all wrong, and all three instructed
    // the reader to raise them. A ratchet needs exactly one recorded value, so the floors are read
    // out of the config here and any restatement has to match it.
    const config = readText('vitest.config.ts');
    const thresholds = config.slice(config.indexOf('thresholds: {'));
    // Per-module globs repeat the same metric names, so stop at the first one.
    const global = thresholds.slice(0, thresholds.indexOf("'lib/"));
    const floors = new Map(
      (['statements', 'branches', 'functions', 'lines'] as const).map((metric) => {
        const found = new RegExp(`\\b${metric}: (\\d+)`).exec(global);
        expect(found, `vitest.config.ts has no global ${metric} floor`).not.toBeNull();
        return [metric, Number(found?.[1])];
      }),
    );
    const wrong: string[] = [];
    for (const rel of DOC_FILES) {
      const text = readText(rel);
      for (const hit of text.matchAll(
        /(\d{2,3})(?:\.\d+)?\s*%?\s*(statements|branches|functions|lines)\b/gi,
      )) {
        const metric = hit[2].toLowerCase();
        if (Number(hit[1]) !== floors.get(metric as 'lines')) wrong.push(`${rel}: ${hit[0]}`);
      }
      // `.cursor/README.md` used the compact form: "Coverage floors are 49/70/65/49".
      for (const hit of text.matchAll(
        /floors?[^\n]{0,24}?(\d{2})\s*\/\s*(\d{2})\s*\/\s*(\d{2})\s*\/\s*(\d{2})/gi,
      )) {
        const stated = [Number(hit[1]), Number(hit[2]), Number(hit[3]), Number(hit[4])];
        const real = ['statements', 'branches', 'functions', 'lines'].map((m) =>
          floors.get(m as 'lines'),
        );
        if (stated.join('/') !== real.join('/')) wrong.push(`${rel}: ${hit[0]}`);
      }
    }
    expect(wrong, 'a document states a coverage floor vitest.config.ts does not set').toEqual([]);
  });

  it('enumerates the verify gate once, in docs/release.md, step for step', () => {
    // F-542. `CLAUDE.md` listed eight of thirteen steps and `AGENTS.md` dropped
    // `playwright-authenticated` — the only automated proof a signed-in user can reach the
    // dashboard, and a step that had already been silently absent from every run once.
    const release = readText('docs', 'release.md');
    const marker = '`verify` order — the **only** enumeration';
    expect(release, 'docs/release.md lost the verify enumeration').toContain(marker);
    const block = release.slice(release.indexOf(marker)).split('\n\n').slice(0, 2).join('\n');
    const items = block.split('\n').filter((line) => /^\d+\. /.test(line));
    // Order, not just membership: the gate stops on the first fatal failure, so "which step is
    // step 7" is the whole value of the list to someone debugging a red run. Membership alone
    // passes a list that has been silently resequenced.
    expect(
      items.map((line) => /`([a-z-]+)`/.exec(line)?.[1]),
      'docs/release.md does not enumerate VERIFY_STEPS in order',
    ).toEqual(VERIFY_STEPS.map((step) => step.id));
    // The other two summaries must point here rather than keep their own list.
    for (const rel of ['AGENTS.md', 'CLAUDE.md']) {
      expect(readText(rel), `${rel} does not point at the runbook`).toContain('docs/release.md');
    }
  });

  // The list is single-sourced, but its *cardinality* was not: `AGENTS.md` and `CLAUDE.md`
  // both stated it in prose, both said "thirteen", and both were wrong the moment the
  // `secret-scan` step landed. Deleting the number was the other option and it is the
  // worse one: the count is the checksum on a list a reader has to follow a link to see —
  // it is how they notice the copy in front of them is truncated — and deleting it leaves
  // nothing for a guard to check, so the next contributor re-adds it unchecked. So it stays,
  // in exactly the two summaries that point at the runbook, and it is derived here.
  const NUMBER_WORDS: Record<string, number> = {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
    eleven: 11,
    twelve: 12,
    thirteen: 13,
    fourteen: 14,
    fifteen: 15,
    sixteen: 16,
    seventeen: 17,
    eighteen: 18,
    nineteen: 19,
    twenty: 20,
  };

  it('states no verify step count that disagrees with VERIFY_STEPS', () => {
    const wrong: string[] = [];
    const stated: string[] = [];
    for (const rel of DOC_FILES) {
      for (const line of readText(rel).split('\n')) {
        // Only claims about this gate: a count is a claim about `verify` or it is about
        // something else entirely (a deploy sequence, a migration expand/contract).
        if (!/verify/i.test(line)) continue;
        for (const hit of line.matchAll(/\b(\d{1,2}|[a-z]+)[ -](?:steps?)\b/gi)) {
          const token = hit[1].toLowerCase();
          const count = /^\d+$/.test(token) ? Number(token) : NUMBER_WORDS[token];
          // "per-project steps", "the fatal steps": a quantifier, not a count.
          if (count === undefined) continue;
          stated.push(`${rel}: ${hit[0]}`);
          if (count !== VERIFY_STEPS.length) wrong.push(`${rel}: ${hit[0]}`);
        }
      }
    }
    expect(
      wrong,
      `a document states a verify step count that is not ${VERIFY_STEPS.length}`,
    ).toEqual([]);
    // A scan with no subjects passes forever, including when its own regex has been broken
    // by a rewording. The two pointers must carry the count for this check to mean anything.
    for (const rel of ['AGENTS.md', 'CLAUDE.md']) {
      expect(
        stated.filter((entry) => entry.startsWith(`${rel}:`)),
        `${rel} points at the runbook without saying how many steps to expect there`,
      ).not.toEqual([]);
    }
  });

  it('numbers a named verify step by its position in VERIFY_STEPS', () => {
    // The same defect one level down, and already live when this was written:
    // docs/release.md called `playwright-critical` "fatal `verify` step 9" and
    // `playwright-authenticated` "step 10". Inserting `secret-scan` at position 3 pushed
    // both along by one, and the numbers are what someone reads to know how far a red run
    // got. An ordinal is checkable exactly when the prose also names the step.
    const ids = VERIFY_STEPS.map((step) => step.id);
    const wrong: string[] = [];
    let seen = 0;
    for (const rel of DOC_FILES) {
      for (const line of readText(rel).split('\n')) {
        for (const hit of line.matchAll(/`verify` step (\d+)/g)) {
          seen += 1;
          // Playwright steps are named by their project (`critical`) as often as by their
          // step id (`playwright-critical`); both forms resolve to the same step.
          const named = ids.filter(
            (id) =>
              line.includes(`\`${id}\``) ||
              (id.startsWith('playwright-') &&
                line.includes(`\`${id.slice('playwright-'.length)}\``)),
          );
          if (named.length !== 1) {
            wrong.push(`${rel}: "${hit[0]}" names no single VERIFY_STEPS id`);
            continue;
          }
          const position = ids.indexOf(named[0]) + 1;
          if (position !== Number(hit[1])) {
            wrong.push(`${rel}: "${hit[0]}" — \`${named[0]}\` is step ${position}`);
          }
        }
      }
    }
    expect(wrong, 'a document numbers a verify step by a position it does not hold').toEqual([]);
    expect(
      seen,
      'no document numbers a verify step — has this check been reworded away?',
    ).toBeGreaterThan(0);
  });

  it('points the dependency overrides at the file pnpm reads them from', () => {
    // F-533. Three documents sent the fixer to `pnpm.overrides` in `package.json`. pnpm 11 reads
    // them from `pnpm-workspace.yaml`, so the edit did nothing, `pnpm audit` stayed red, and the
    // natural next move is dropping the audit step the same documents forbid dropping.
    const pkg = JSON.parse(readText('package.json'));
    const workspace = readText('pnpm-workspace.yaml');
    if (pkg.pnpm?.overrides) return;
    expect(workspace, 'pnpm-workspace.yaml has no overrides block').toMatch(/^overrides:/m);
    expect(
      unnegatedMentions(DOC_FILES, /pnpm\.overrides/g),
      'a document sends the overrides fixer to `pnpm.overrides`, which this repo does not have',
    ).toEqual([]);
  });

  it('names only per-stack prompt files that exist', () => {
    // F-540. The comparison doc named six and shipped a self-verification command over all six, so
    // running it errors on the four missing files instead of proving anything.
    const present = new Set(readdirSync(join(ROOT, 'lib', 'stack-prompts')));
    const missing: string[] = [];
    for (const rel of DOC_FILES) {
      const text = readText(rel);
      // Both the plain form and the brace-expanded shell form the doc used.
      for (const hit of text.matchAll(/lib\/stack-prompts\/(?:\{([^}]+)\}|([\w-]+))\.ts/g)) {
        for (const name of (hit[1] ?? hit[2]).split(',')) {
          if (!present.has(`${name.trim()}.ts`)) missing.push(`${rel}: ${name.trim()}.ts`);
        }
      }
    }
    expect(missing, 'a document names a stack prompt that does not exist').toEqual([]);
  });

  it('gives every working tree a port', () => {
    // F-539. A third worktree existed with no row in the table, so it had no assigned port and no
    // owner — while sharing one Postgres with the other two. The table is the allocation
    // mechanism, so an unlisted checkout is an unallocated one.
    const rule = readText('.cursor', 'rules', 'single-dev-server.mdc');
    const trees = existsSync(join(ROOT, '.worktrees'))
      ? readdirSync(join(ROOT, '.worktrees'), { withFileTypes: true }).filter((entry) =>
          entry.isDirectory(),
        )
      : [];
    for (const tree of trees) {
      expect(rule, `.worktrees/${tree.name} has no row in the port table`).toContain(
        `.worktrees/${tree.name}`,
      );
    }
  });

  it('names only settings the registry defines, in the credential docs', () => {
    // F-535. `docs/coolify.md` sent operators to a `tooling.e2b.apiKey` that no registry entry
    // has, on a deployment guide, next to a claim that the AI keys are editable in the same place.
    const registry = readText('lib', 'settings', 'registry.ts');
    const known = new Set([...registry.matchAll(/key: '([^']+)'/g)].map((hit) => hit[1]));
    const unknown: string[] = [];
    for (const rel of CREDENTIAL_DOCS) {
      const text = readText(rel);
      for (const hit of text.matchAll(
        /`((?:ai|tooling|storage|backups|email|github|app|preview)\.[a-z][A-Za-z0-9.]*)`/g,
      )) {
        if (!known.has(hit[1])) unknown.push(`${rel}: ${hit[1]}`);
      }
    }
    expect(unknown, 'an operator doc names a setting the registry does not define').toEqual([]);
  });

  it('documents every environment variable the application code reads', () => {
    // F-546. `SOURCE_COMMIT` decides the release sha a rollback compares against and
    // `NAVROOP_FILE_CONTEXT_TOKEN_CAP` changes generation cost; neither appeared in any document
    // or in `.env.example`, so a deployment could report a sha from a variable no runbook names.
    const documented = [...DOC_FILES, '.env.example'].map((rel) => readText(rel)).join('\n');
    // Set by the platform, never by an operator: Next per bundle, the container, the OS shell, git.
    const PLATFORM_PROVIDED: Record<string, true> = {
      NEXT_RUNTIME: true,
      HOSTNAME: true,
      USERNAME: true,
      GIT_AUTHOR_NAME: true,
    };
    const sources: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
        if (entry.isDirectory()) walk(`${dir}/${entry.name}`);
        else if (/\.(?:ts|tsx|mjs)$/.test(entry.name)) sources.push(`${dir}/${entry.name}`);
      }
    };
    for (const dir of ['lib', 'app', 'scripts']) walk(dir);
    // Root config files too: `PLAYWRIGHT_BASE_URL` (`playwright.config.ts`) was one of the
    // originally reported gaps and lives outside all three trees, as do the Sentry configs,
    // `proxy.ts` and `docker-entrypoint.mjs` — the files an operator's environment reaches first.
    for (const entry of readdirSync(ROOT, { withFileTypes: true })) {
      if (entry.isFile() && /\.(?:ts|mjs)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
        sources.push(entry.name);
      }
    }
    const undocumented = new Map<string, string>();
    for (const rel of sources) {
      for (const hit of readText(rel).matchAll(/process\.env\.([A-Z][A-Z0-9_]{2,})/g)) {
        if (PLATFORM_PROVIDED[hit[1]] || documented.includes(hit[1])) continue;
        if (!undocumented.has(hit[1])) undocumented.set(hit[1], rel);
      }
    }
    expect(
      [...undocumented].map((row) => row.join(' <- ')),
      'undocumented env vars',
    ).toEqual([]);
  });

  it('names the image providers the assets pipeline actually has', () => {
    // F-544. Both maps said "Unsplash stock". The pipeline generates first through a self-hosted
    // image worker and falls back to keyless Openverse — the thing that makes a no-key install
    // ship real photographs instead of grey boxes, and it was undiscoverable.
    const assets = join(ROOT, 'lib', 'assets');
    for (const [file, claim] of [
      ['openverse.ts', 'Openverse'],
      ['image-worker.ts', 'image worker'],
    ] as const) {
      if (!existsSync(join(assets, file))) continue;
      for (const rel of ['AGENTS.md', '.cursor/README.md']) {
        expect(readText(rel), `${rel} does not mention ${claim}`).toContain(claim);
      }
    }
  });

  it('keeps the doc-freshness rule as wide as the doc set it governs', () => {
    // F-551. `keep-cursor-current.mdc` is the rule that exists to stop this drift, and its sync
    // list named `AGENTS.md`, `.cursor/README.md` and four `*.mdc` files. Every finding in this
    // file was in a document the rule did not cover, `README.md` most of all.
    const rule = readText('.cursor', 'rules', 'keep-cursor-current.mdc');
    for (const claim of ['README.md', 'CLAUDE.md', 'AGENTS.md', '.cursor/rules/', 'docs/']) {
      expect(rule, `keep-cursor-current.mdc does not list ${claim}`).toContain(claim);
    }
  });

  it('names every project API route in AGENTS.md', () => {
    // F-550. Eight routes under `app/api/projects/[id]/` appeared in neither map — including
    // the three `job/*` endpoints the RecoveryPanel calls and `checkpoints/exit`. The map is
    // the inventory, so a route outside it is a route nobody reviews when the surface changes.
    // Reading the surface off the filesystem is what makes the next addition fail here rather
    // than go unnoticed; `.cursor/README.md` is the compact mirror and is deliberately not
    // pinned, because two inventories is the failure mode this file exists to catch.
    const base = join(ROOT, 'app', 'api', 'projects', '[id]');
    const routes: string[] = [];
    const walk = (rel: string) => {
      for (const entry of readdirSync(join(base, rel), { withFileTypes: true })) {
        const next = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(next);
        else if (entry.name === 'route.ts' && rel) routes.push(rel);
      }
    };
    walk('');
    const agents = readText('AGENTS.md');
    expect(routes.length).toBeGreaterThan(20);
    expect(routes.filter((rel) => !agents.includes(`/api/projects/[id]/${rel}`))).toEqual([]);
  });

  it('maps the Claude Code configuration from AGENTS.md', () => {
    // F-554. The layout table was headed "Cursor layout" and listed only `.cursor/**`, so half
    // the agent configuration in the repository was invisible from the file `CLAUDE.md`
    // designates as the map — including the 204-file `.claude/skills/` tree the Skill tool
    // actually loads and the gitignored `settings.local.json` that enables an MCP server.
    // F-548 is the root `.mcp.json`, which no document named at all, and F-549 is
    // `docs/superpowers/specs/`, the only record of the post-sandbox preview architecture.
    const agents = readText('AGENTS.md');
    /**
     * `.claude/settings.local.json` is deliberately gitignored, so whether it exists
     * is a property of one developer's machine, not of the repository. Asserting
     * existence made this test pass only where someone had already created it and
     * fail in every fresh checkout and on CI. AGENTS.md still has to name it —
     * that is the claim under test — but only the tracked paths are checked on disk.
     */
    const GITIGNORED_CLAIMS: Record<string, true> = { '.claude/settings.local.json': true };
    for (const claim of [
      'CLAUDE.md',
      '.claude/skills/',
      '.claude/settings.json',
      '.claude/settings.local.json',
      '.mcp.json',
      'docs/superpowers/specs/',
    ]) {
      if (!GITIGNORED_CLAIMS[claim]) {
        expect(existsSync(join(ROOT, claim)), `${claim} does not exist`).toBe(true);
      }
      expect(agents, `AGENTS.md does not map ${claim}`).toContain(claim);
    }
    // `dev3000` is enabled by default from a gitignored file; naming the server is the point.
    expect(JSON.parse(readText('.mcp.json')).mcpServers).toHaveProperty('dev3000');
    expect(agents).toContain('dev3000');
  });

  it('sends each host to the skill tree it actually loads', () => {
    // F-553. `AGENTS.md`, `.cursor/README.md` and `skills-availability.mdc` all sent every
    // agent to `.cursor/skills/`, while `CLAUDE.md` says the Skill tool loads `.claude/skills/`.
    // Byte-identity (`tests/unit/skill-trees-in-sync.test.ts`) makes that harmless today and
    // wrong the moment one tree is edited alone, which is the failure that test exists to stop.
    for (const rel of ['AGENTS.md', '.cursor/README.md', '.cursor/rules/skills-availability.mdc']) {
      const text = readText(rel);
      expect(text, `${rel} never mentions .claude/skills/`).toContain('.claude/skills/');
      expect(text, `${rel} does not name the sync guard`).toContain('skill-trees-in-sync');
    }
  });

  it('does not grant a read the Claude Code harness denies', () => {
    // F-552. `coolify-local-secrets.mdc` is always-on and imported by `CLAUDE.md`, and it said
    // agents MAY read `.cursor/.env.deploy` or `.env.local`. Both are in `permissions.deny`
    // (`.env.local` via `./.env.*`), so the rule bought a refused tool call and offered no
    // fallback. The deny list is the right policy; the rule is what had to change, and this
    // pins the pair together: deny a path, and the rule that grants it has to say so.
    const settings = JSON.parse(readText('.claude', 'settings.json')) as {
      permissions?: { deny?: string[] };
    };
    const denied = settings.permissions?.deny ?? [];
    expect(denied).toContain('Read(./.cursor/.env.deploy)');
    const rule = readText('.cursor', 'rules', 'coolify-local-secrets.mdc');
    for (const claim of ['.claude/settings.json', 'permissions.deny', '/admin/integrations']) {
      expect(rule, `coolify-local-secrets.mdc does not mention ${claim}`).toContain(claim);
    }
    // Every env path the harness refuses has to be named in the rule that talks about reading them.
    const named = denied
      .filter((entry) => /^Read\(\.\/\.(?:env|cursor\/\.env)/.test(entry))
      .map((entry) => entry.slice('Read(.'.length, -1));
    expect(named.length).toBeGreaterThan(0);
    expect(named.filter((path) => !rule.includes(path))).toEqual([]);
  });

  it('keeps one install-script policy, and states it', () => {
    // F-547. `pnpm-workspace.yaml` maintains a ten-package `allowBuilds` allowlist — the
    // mechanism for deciding whose postinstall may run — and `.npmrc` then set
    // `dangerouslyAllowAllBuilds=true`, which voids it for every transitive dependency, in a
    // repo whose verify gate treats a high-severity advisory as fatal. Two files disagreed and
    // neither said which was the policy. F-700/F-635 deleted the flag; this keeps it deleted
    // and keeps the allowlist named where an install is configured, so the pair cannot drift
    // back into silently disagreeing.
    const workspace = readText('pnpm-workspace.yaml');
    const npmrc = readText('.npmrc');
    expect(workspace).toContain('allowBuilds:');
    // Naming it in order to forbid it is the whole point of the comment, so match an
    // assignment rather than a mention.
    expect(npmrc).not.toMatch(/^\s*dangerouslyAllowAllBuilds\s*=/m);
    expect(npmrc, '.npmrc does not point at the allowlist it defers to').toContain(
      'pnpm-workspace.yaml',
    );
    expect(npmrc, '.npmrc does not name the flag it refuses').toContain(
      'dangerouslyAllowAllBuilds',
    );
  });
});
