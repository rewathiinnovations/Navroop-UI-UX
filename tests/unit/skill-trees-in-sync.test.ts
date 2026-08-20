import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `CLAUDE.md` states an obligation: "A skill that exists in both trees and is edited
 * in one place must be copied to the other, or the two drift apart silently."
 * Nothing enforced it — both trees are excluded from ESLint and from the tsc program,
 * and `verify` never compares them (F-507). These are that mechanism: the paired files
 * must stay byte-identical, the Cursor-only pack must stay out of the Claude Code tree
 * (F-500, F-502, F-505), a documented script path must actually resolve (F-504), and no
 * compiled Python bytecode may be tracked in either tree (F-506).
 */

const repoRoot = process.cwd();
const CLAUDE_TREE = join(repoRoot, '.claude', 'skills');
const CURSOR_TREE = join(repoRoot, '.cursor', 'skills');

/**
 * Which `.cursor/skills/` sub-pack each skill in `.claude/skills/` was copied from.
 * `''` means the skill sits at the root of `.cursor/skills/`. A skill copied into
 * `.claude/skills/` without an entry here fails the mapping test on purpose: whoever
 * copies it has to say where its counterpart lives.
 */
const PACK_OF_SKILL: Readonly<Record<string, string>> = {
  // Host-agnostic skills that ship inside Cursor's own pack.
  autopilot: 'cursor',
  'split-to-prs': 'cursor',
  // The Superpowers plugin pack.
  brainstorming: 'superpowers',
  'dispatching-parallel-agents': 'superpowers',
  'executing-plans': 'superpowers',
  'finishing-a-development-branch': 'superpowers',
  'receiving-code-review': 'superpowers',
  'requesting-code-review': 'superpowers',
  'subagent-driven-development': 'superpowers',
  'systematic-debugging': 'superpowers',
  'test-driven-development': 'superpowers',
  'using-git-worktrees': 'superpowers',
  'using-superpowers': 'superpowers',
  'verification-before-completion': 'superpowers',
  'writing-plans': 'superpowers',
  'writing-skills': 'superpowers',
  // Design packs, stored at the root of `.cursor/skills/`.
  design: '',
  'design-system': '',
  'ui-styling': '',
  'ui-ux-pro-max': '',
};

/** The Claude Code tree is the smaller one; anything below this means the walk broke. */
const MIN_PAIRED_FILES = 150;

function walk(base: string, rel = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(base, rel), { withFileTypes: true })) {
    const next = rel ? `${rel}/${entry.name}` : entry.name;
    // CPython writes `__pycache__` on first import, with an embedded mtime header, so the
    // same source produces different bytes per machine and per run. It is never skill
    // content: it is excluded from the walk here and kept out of git below (F-506).
    if (entry.name === '__pycache__') continue;
    if (entry.isDirectory()) out.push(...walk(base, next));
    else if (entry.isFile()) out.push(next);
  }
  return out.sort();
}

/** `.cursor/skills/` path for a `.claude/skills/`-relative path, or null if unmapped. */
function counterpart(rel: string): string | null {
  const skill = rel.split('/')[0];
  const pack = PACK_OF_SKILL[skill];
  if (pack === undefined) return null;
  return pack ? join(CURSOR_TREE, pack, rel) : join(CURSOR_TREE, rel);
}

describe('skill trees stay in sync', () => {
  const claudeFiles = walk(CLAUDE_TREE);

  it('walks both trees', () => {
    expect(claudeFiles.length).toBeGreaterThanOrEqual(MIN_PAIRED_FILES);
    expect(existsSync(CURSOR_TREE)).toBe(true);
  });

  it('tracks no compiled Python bytecode in either tree', () => {
    // Four `.pyc` blobs for CPython 3.12 were committed under
    // `{.claude,.cursor}/skills/ui-ux-pro-max/scripts/__pycache__/` (F-506). `.gitignore`
    // carved out caches and secrets for both trees and said nothing about `__pycache__`,
    // so the only binaries in an otherwise text-only config tree arrived by accident — and
    // a stale `.pyc` can shadow an edited `.py` when the timestamps line up.
    //
    // Tracked-and-present is the thing being asserted, and both halves are load-bearing.
    // Running the vendored pytest suites regenerates `__pycache__` locally — fine, and now
    // ignored — so an untracked one is not a defect. An index entry whose file is already
    // gone is a staged deletion, i.e. the fix in flight, not a committed blob. What must
    // never hold again is a `.pyc` that git knows about and that is really there.
    // `tests/setup/repo-write-guard.ts` already shells out to git, so this adds no new
    // requirement on the environment.
    const listed = spawnSync('git', ['ls-files', '-z', '--', '.claude/skills', '.cursor/skills'], {
      cwd: repoRoot,
      encoding: 'utf8',
      windowsHide: true,
    });
    expect(
      !listed.error && listed.status === 0,
      'git could not list tracked skill files, so this guard has no answer to give',
    ).toBe(true);
    const tracked = (listed.stdout || '').split('\0').filter((entry) => entry.length > 0);
    expect(tracked.length).toBeGreaterThanOrEqual(MIN_PAIRED_FILES);
    const committedBytecode = tracked.filter(
      (rel) =>
        (rel.includes('__pycache__') || rel.endsWith('.pyc')) && existsSync(join(repoRoot, rel)),
    );
    expect(committedBytecode).toEqual([]);
  });

  it('ignores compiled Python bytecode in both trees', () => {
    // Deleting the four files closes today; the ignore rule is what stops the next
    // `python -m pytest` under a skill's `scripts/tests/` from re-adding them (F-506).
    const ignore = readFileSync(join(repoRoot, '.gitignore'), 'utf8');
    for (const tree of ['.cursor', '.claude']) {
      expect(ignore, `.gitignore does not ignore ${tree} bytecode`).toContain(
        `${tree}/skills/**/__pycache__/`,
      );
      expect(ignore, `.gitignore does not ignore ${tree} .pyc`).toContain(
        `${tree}/skills/**/*.pyc`,
      );
    }
  });

  it('maps every copied skill to a declared .cursor/skills pack', () => {
    const undeclared = readdirSync(CLAUDE_TREE, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && PACK_OF_SKILL[entry.name] === undefined)
      .map((entry) => entry.name);
    expect(undeclared).toEqual([]);
  });

  it('pairs every .claude/skills file with an existing .cursor/skills file', () => {
    const orphans = claudeFiles.filter((rel) => {
      const mirror = counterpart(rel);
      return mirror === null || !existsSync(mirror) || !statSync(mirror).isFile();
    });
    expect(orphans).toEqual([]);
  });

  it('keeps every paired file byte-identical', () => {
    const drifted: string[] = [];
    let compared = 0;
    for (const rel of claudeFiles) {
      const mirror = counterpart(rel);
      if (mirror === null || !existsSync(mirror)) continue; // reported by the pairing test
      compared += 1;
      if (!readFileSync(join(CLAUDE_TREE, rel)).equals(readFileSync(mirror))) drifted.push(rel);
    }
    expect(drifted).toEqual([]);
    expect(compared).toBeGreaterThanOrEqual(MIN_PAIRED_FILES);
  });

  it('keeps the Cursor-only pack out of the Claude Code tree', () => {
    const portable = new Set(
      Object.entries(PACK_OF_SKILL)
        .filter(([, pack]) => pack === 'cursor')
        .map(([skill]) => skill),
    );
    const copied = readdirSync(join(CURSOR_TREE, 'cursor'), { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() &&
          !portable.has(entry.name) &&
          existsSync(join(CLAUDE_TREE, entry.name)),
      )
      .map((entry) => entry.name);
    // Those skills drive Cursor-only tools and paths, and several are slash-only
    // behind `disable-model-invocation`, a key Claude Code ignores (F-501, F-502,
    // F-503, F-505). Two of them would also shadow built-in slash commands (F-500).
    expect(copied).toEqual([]);
  });
});

describe('vendored skill scripts resolve inside the repo', () => {
  /**
   * Every paired file, in both trees, that could carry a command: docs and the scripts
   * themselves (a script can print a suggested command — `design/scripts/cip/generate.py`
   * did). `skillRel` is the path with the `.cursor/skills/{superpowers,cursor}/` pack
   * segment removed, so the same file has one key in both trees. Unpaired
   * `.cursor/skills/cursor/**` files are excluded by construction: they exist in the
   * Cursor tree only, so a `.cursor/...` path in them is true.
   */
  const COMMAND_BEARING = /\.(md|py|ts|tsx|js|cjs|mjs|sh)$/;
  const sources = walk(CLAUDE_TREE)
    .filter((rel) => COMMAND_BEARING.test(rel))
    .flatMap((rel) => {
      const mirror = counterpart(rel);
      const skillRel = rel;
      return mirror === null || !existsSync(mirror)
        ? [{ path: join(CLAUDE_TREE, rel), skillRel }]
        : [
            { path: join(CLAUDE_TREE, rel), skillRel },
            { path: mirror, skillRel },
          ];
    });

  /**
   * Any command that reaches a bundled script through a tree-named path is wrong in at
   * least one of the two trees. `~/.claude/skills/...` runs a different, unversioned copy
   * from the user profile, or nothing at all (F-504, N-010); a bare `.claude/skills/...`
   * resolves from the repository root but is a lie in the Cursor copy, which byte-identity
   * guarantees exists (N-010 extension). The only correct forms are `$SKILL_DIR/...` for
   * this skill and `$SKILLS_DIR/<other-skill>/...` for a sibling.
   */
  const INVOCATION =
    /\b(?:python3?|node|bash|sh|pwsh|powershell)\s+"?[^\s"]*\.(?:cursor|claude)[\\/]skills/;

  it('reads the skill sources', () => {
    expect(sources.length).toBeGreaterThanOrEqual(80);
  });

  it('never reaches a bundled script through a tree-named path', () => {
    const offenders: string[] = [];
    for (const { path: file } of sources) {
      for (const [index, line] of readFileSync(file, 'utf8').split('\n').entries()) {
        if (INVOCATION.test(line)) {
          offenders.push(`${file.slice(repoRoot.length + 1).replaceAll('\\', '/')}:${index + 1}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('points $SKILL_DIR and $SKILLS_DIR references at files that exist in both trees', () => {
    // `$SKILL_DIR/x` resolves under the skill that documents it; `$SKILLS_DIR/x` resolves
    // under the tree root, so it can name a sibling skill.
    const referenced = new Set<string>();
    for (const { path: file, skillRel } of sources) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(/\$SKILL_DIR\/([\w./-]+)/g)) {
        referenced.add(`${skillRel.split('/')[0]}/${match[1]}`);
      }
      for (const match of text.matchAll(/\$SKILLS_DIR\/([\w./-]+)/g)) {
        referenced.add(match[1]);
      }
    }
    const missing = [...referenced]
      .flatMap((rel) => {
        const pack = PACK_OF_SKILL[rel.split('/')[0]];
        const paths = [
          join(CLAUDE_TREE, rel),
          pack ? join(CURSOR_TREE, pack, rel) : join(CURSOR_TREE, rel),
        ];
        return paths.filter((candidate) => !existsSync(candidate));
      })
      .map((candidate) => candidate.slice(repoRoot.length + 1).replaceAll('\\', '/'));
    expect(referenced.size).toBeGreaterThan(0);
    expect(missing).toEqual([]);
  });

  it('wraps stdout in UTF-8 in every python script that prints non-ASCII', () => {
    /**
     * `print()` on Windows encodes through the console code page (cp1252 by default), so
     * one `→` or `✅` in the output raises UnicodeEncodeError mid-run: the operator gets
     * a partial result and a traceback from a command the docs told them to run (N-012).
     * `ui-ux-pro-max/scripts/search.py` established the fix; these scripts had missed it.
     * The check is deliberately narrow — non-ASCII in this file's own code, and this file
     * prints. A script printing non-ASCII produced only by an imported module would slip
     * through; the wrapper belongs in whoever calls `print`, which is what this measures.
     */
    const WRAPPER = /sys\.stdout = io\.TextIOWrapper\(sys\.stdout\.buffer, encoding='utf-8'\)/;
    const unwrapped: string[] = [];
    let checked = 0;
    for (const { path: file } of sources.filter(({ path: file }) => file.endsWith('.py'))) {
      const text = readFileSync(file, 'utf8');
      const printsNonAscii =
        /\bprint\(/.test(text) &&
        text.split('\n').some((line) => !/^\s*#/.test(line) && /[^\u0000-\u007F]/.test(line));
      if (!printsNonAscii) continue;
      checked += 1;
      if (!WRAPPER.test(text))
        unwrapped.push(file.slice(repoRoot.length + 1).replaceAll('\\', '/'));
    }
    expect(unwrapped).toEqual([]);
    expect(checked).toBeGreaterThanOrEqual(16);
  });

  it('declares every vendored script that spends money on a paid API', () => {
    /**
     * `design` is auto-selectable — its `description:` advertises "logo generation … Gemini
     * AI" — and three of its scripts bill Google's Gemini API against `GEMINI_API_KEY`,
     * which is also the env fallback for the product's own `ai.google.apiKey`. No repo
     * document said so, so an agent could spend the deployment's image-generation budget on
     * a logo with no plan check, no `checkCredits`, and nothing on `/admin/usage` (F-508).
     *
     * A script that reads an `*_API_KEY` and then calls a model is the mechanical signature
     * of billable work. Each one has to be named in the always-on skill inventory and in its
     * own `SKILL.md`, so the cost is visible both to an agent orienting itself and to an
     * operator about to run the command. A new paid script fails this until it is declared.
     */
    const READS_KEY = /os\.environ(?:\.get\(\s*)?["'][A-Z0-9_]*_API_KEY["']/;
    const CALLS_MODEL =
      /\b(?:generate_content|generativelanguage\.googleapis\.com|chat\.completions)\b/;
    const inventory = readFileSync(
      join(repoRoot, '.cursor', 'rules', 'skills-availability.mdc'),
      'utf8',
    );

    const undeclared: string[] = [];
    let billable = 0;
    for (const rel of walk(CLAUDE_TREE).filter((entry) => entry.endsWith('.py'))) {
      const text = readFileSync(join(CLAUDE_TREE, rel), 'utf8');
      if (!READS_KEY.test(text) || !CALLS_MODEL.test(text)) continue;
      billable += 1;
      const skill = rel.split('/')[0];
      // The inventory names it as `<skill>/scripts/…`; the skill's own doc as `scripts/…`.
      if (!inventory.includes(rel))
        undeclared.push(`.cursor/rules/skills-availability.mdc: ${rel}`);
      const doc = join(CLAUDE_TREE, skill, 'SKILL.md');
      const own = existsSync(doc) ? readFileSync(doc, 'utf8') : '';
      if (!own.includes(rel.slice(skill.length + 1))) undeclared.push(`${skill}/SKILL.md: ${rel}`);
      if (!/\bpaid\b/i.test(own)) undeclared.push(`${skill}/SKILL.md does not say "paid"`);
    }
    expect(undeclared).toEqual([]);
    // logo, cip, icon. Zero would mean the detector stopped matching, not that nothing bills.
    expect(billable).toBe(3);
  });
});
