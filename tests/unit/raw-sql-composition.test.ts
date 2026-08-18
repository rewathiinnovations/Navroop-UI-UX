import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * No file under `lib/`, `app/`, or `scripts/` may interpolate a composed SQL fragment
 * into a `$queryRaw` / `$executeRaw` tagged template.
 *
 * Why a static check and not a database test: the failure is environment-dependent.
 * Prisma's tagged-template path binds every `${...}` as a parameter and only flattens a
 * nested `Prisma.sql` / `Prisma.join` / `Prisma.raw` fragment when that fragment's `Sql`
 * class is the same instance the client runtime holds. Under plain Node — which is where
 * Vitest runs — the identity matches and the SQL comes out correct, so a real-database
 * test passes. Inside the bundled Next server it did not match, the fragment was bound
 * as a value, and `SET "heartbeatAt" = $1` became `SET $1`, which Postgres rejects with
 * 42601 on every job heartbeat.
 *
 * So no test that executes SQL from Vitest can catch this class of bug. This one reads
 * the source instead. The supported shapes are `$queryRawUnsafe` / `$executeRawUnsafe`
 * with SQL text this repo builds and placeholders it numbers itself.
 *
 * Every raw SQL call site lives under `lib/` today, which is exactly why the other two
 * roots are scanned: this static read is the entire defence, so the first route handler
 * or migration script to reach for `$executeRaw` must not arrive unpoliced.
 */

/** Roots that may talk to Postgres, with the floor each one is known to exceed. */
const ROOTS: Array<{ dir: string; minFiles: number }> = [
  { dir: 'lib', minFiles: 300 },
  { dir: 'app', minFiles: 120 },
  { dir: 'scripts', minFiles: 10 },
];

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...tsFiles(full));
      continue;
    }
    // `.tsx` too: a server component is as able to run raw SQL as a route is.
    if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

function repoPath(file: string) {
  return relative(process.cwd(), file).split(sep).join('/');
}

function scannedFiles() {
  const out: string[] = [];
  for (const root of ROOTS) {
    const dir = join(process.cwd(), root.dir);
    if (!existsSync(dir)) throw new Error(`raw SQL scan root is missing: ${root.dir}`);
    out.push(...tsFiles(dir));
  }
  return out;
}

/** Every `` prisma.$queryRaw`...` `` / `` $executeRaw`...` `` tagged template body. */
function taggedTemplateBodies(source: string): string[] {
  const bodies: string[] = [];
  const tag = /\$(?:query|execute)Raw\s*(?:<[^`]*?>)?\s*`/g;
  let match = tag.exec(source);
  while (match) {
    const start = tag.lastIndex;
    // Template literals here contain no nested backticks, so the next one ends the body.
    const end = source.indexOf('`', start);
    if (end === -1) break;
    bodies.push(source.slice(start, end));
    tag.lastIndex = end + 1;
    match = tag.exec(source);
  }
  return bodies;
}

/** `Prisma.sql` / `join` / `raw` / `empty` used directly inside `${...}`. */
const INLINE_FRAGMENT = /\$\{\s*Prisma\s*\.\s*(?:sql|join|raw|empty)\b/;

/** Names bound to a fragment in this file, e.g. `const JOB_SELECT = Prisma.raw(...)`. */
function fragmentNames(source: string): Set<string> {
  const names = new Set<string>();
  const declaration = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*Prisma\s*\.\s*(?:sql|join|raw|empty)\b/g;
  let match = declaration.exec(source);
  while (match) {
    names.add(match[1]);
    match = declaration.exec(source);
  }
  return names;
}

/** The interpolated fragment in `body`, or null. Plain bound values are not fragments. */
function findFragment(body: string, names: Set<string>): string | null {
  const inline = INLINE_FRAGMENT.exec(body);
  if (inline) return inline[0].replace(/\s+/g, '');
  for (const name of names) {
    if (new RegExp(`\\$\\{\\s*${name}\\s*\\}`).test(body)) return `\${${name}}`;
  }
  return null;
}

describe('raw SQL composition across lib, app and scripts', () => {
  const files = scannedFiles();
  const repoFiles = files.map(repoPath);

  it('reaches every root it claims to scan', () => {
    // A walker that silently stopped at one root — or matched nothing at all —
    // would make the offender check below pass vacuously for the rest.
    for (const root of ROOTS) {
      const inRoot = repoFiles.filter((file) => file.startsWith(`${root.dir}/`));
      expect(inRoot.length, `${root.dir} file count`).toBeGreaterThan(root.minFiles);
    }
    expect(repoFiles).toContain('lib/jobs/store.ts');
    expect(repoFiles).toContain('app/api/health/route.ts');
    expect(repoFiles).toContain('scripts/backup-db.ts');
    // `.tsx` has to be in scope or app/ would be half-scanned.
    expect(repoFiles.some((file) => file.startsWith('app/') && file.endsWith('.tsx'))).toBe(true);
  });

  it('finds the raw SQL call sites it is meant to police', () => {
    const withRawSql = repoFiles.filter(
      (file) => taggedTemplateBodies(readFileSync(join(process.cwd(), file), 'utf8')).length > 0,
    );
    // Guard against the matcher silently breaking and the suite passing on nothing.
    expect(withRawSql.length).toBeGreaterThan(15);
    expect(withRawSql.some((file) => file.startsWith('lib/'))).toBe(true);
    // Widening the scan was not hypothetical: this call site predates it and
    // was unpoliced the whole time, because the walker only read `lib/`.
    expect(withRawSql).toContain('scripts/pre-migrate.ts');
  });

  it('never interpolates a composed fragment into a tagged template', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      const names = fragmentNames(source);
      for (const body of taggedTemplateBodies(source)) {
        const hit = findFragment(body, names);
        if (hit) offenders.push(`${repoPath(file)}: ${hit}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('recognises both shapes that broke the job store', () => {
    const inlineJoin = [
      'const sets: Prisma.Sql[] = [Prisma.sql`"updatedAt" = NOW()`];',
      "await prisma.$executeRaw`UPDATE \"GenerationJob\" SET ${Prisma.join(sets, ', ')} WHERE id = ${id}`;",
    ].join('\n');
    expect(findFragment(taggedTemplateBodies(inlineJoin)[0], fragmentNames(inlineJoin))).toBe('${Prisma.join');

    const namedFragment = [
      'const JOB_SELECT = Prisma.raw(`id, "projectId"`);',
      'await prisma.$queryRaw<Row[]>`SELECT ${JOB_SELECT} FROM "GenerationJob" WHERE id = ${id}`;',
    ].join('\n');
    expect(findFragment(taggedTemplateBodies(namedFragment)[0], fragmentNames(namedFragment))).toBe(
      '${JOB_SELECT}',
    );
  });

  it('would flag an offender written in a route handler or a script', () => {
    // The reason for widening the scan, as a control: the same two shapes, in
    // the shape a route or a script would write them.
    const inRoute = [
      "const order = Prisma.raw('\"createdAt\" DESC');",
      'const rows = await prisma.$queryRaw<Row[]>`SELECT id FROM "Project" ORDER BY ${order}`;',
    ].join('\n');
    expect(findFragment(taggedTemplateBodies(inRoute)[0], fragmentNames(inRoute))).toBe('${order}');

    const inScript = [
      'await prisma.$executeRaw`DELETE FROM "Checkpoint" WHERE ${Prisma.sql`"projectId" = ${id}`}`;',
    ].join('\n');
    expect(findFragment(taggedTemplateBodies(inScript)[0], fragmentNames(inScript))).toBe('${Prisma.sql');
  });

  it('does not flag ordinary bound values', () => {
    // Constants and expressions bound as parameters are the normal, correct usage; the
    // rule has to leave them alone or it would ban raw SQL outright.
    const fine = [
      "const KEY = 'ssrf.privateRejects';",
      'await prisma.$executeRaw`UPDATE "AppSetting" SET value = ${JSON.stringify(next)} WHERE key = ${KEY}`;',
    ].join('\n');
    expect(findFragment(taggedTemplateBodies(fine)[0], fragmentNames(fine))).toBeNull();
  });
});
