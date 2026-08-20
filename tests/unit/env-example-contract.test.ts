import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BOOTSTRAP_ENV_VARS, SETTINGS } from '@/lib/settings/registry';

/**
 * `.env.example` is the only inventory an operator has, and three separate ways of being
 * wrong had all shipped at once.
 *
 * Fourteen `env:` names from `lib/settings/registry.ts` had no line in the file at all, so the
 * image worker, Unsplash's application id and secret, the S3 alias names, the local backup
 * directory and the preview host were discoverable only by reading the registry source
 * (F-733). Four variables were defined twice with different values — a "COOLIFY" block at the
 * top and a development block below — and dotenv keeps the last occurrence, so an operator who
 * filled in the top block and deployed silently ran on `127.0.0.1:5433` (F-734). And in the
 * other direction the file advertised `SANDBOX_IDLE_MINUTES` and a whole AI provider chain that
 * no code read (F-717, F-712), which is worse than saying nothing: the operator pastes a real
 * credential and nothing uses it.
 *
 * Forwarding matters as much as documenting. A variable missing from `docker-compose.yml`'s
 * `environment:` block never reaches the container, so /admin/config shows the field as
 * unconfigured however carefully the operator set it in Coolify.
 *
 * The scans are textual on purpose: they read the files the way an operator does, they need no
 * build step, and they fail on exactly the mistake they guard.
 */

const ROOT = process.cwd();

/**
 * Every scan below is newline-normalised at the read.
 *
 * `core.autocrlf=true` plus a `.gitattributes` that only pins `Dockerfile`, `*.sh`
 * and `docker-entrypoint.mjs` to LF means these YAML/env files arrive CRLF in a
 * fresh Windows checkout. A literal `'\n    environment:\n'` probe then finds
 * nothing and the scan reports the block as absent rather than as unmatched —
 * a silent false pass in the other direction, and a hard failure here.
 */
const readText = (...parts: string[]) =>
  readFileSync(join(ROOT, ...parts), 'utf8').replace(/\r\n/g, '\n');

const example = readText('.env.example');
const compose = readText('docker-compose.yml');

type Definition = { name: string; commented: boolean; line: number };

const definitions: Definition[] = [];
for (const [index, line] of example.split(/\r?\n/).entries()) {
  const match = /^\s*(#\s*)?([A-Z][A-Z0-9_]*)\s*=/.exec(line);
  if (match) definitions.push({ name: match[2], commented: Boolean(match[1]), line: index + 1 });
}
const defined = new Set(definitions.map((row) => row.name));

/** `env:` names, which are the ones an operator is expected to set. */
const PRIMARY_ENV = SETTINGS.flatMap((entry) => (entry.env ? [entry.env] : []));
/** Accepted alternative spellings. Documented as prose, so a reader sets one name, not two. */
const ALIAS_ENV = [...new Set(SETTINGS.flatMap((entry) => entry.envAliases ?? []))];
/** Runtime-provided, and the registry says so in its own help text. */
const PLATFORM_PROVIDED: Record<string, true> = { NODE_ENV: true };

function composeRuntimeKeys() {
  const start = compose.indexOf('\n    environment:\n');
  expect(start, 'docker-compose.yml has no app environment block').toBeGreaterThan(-1);
  const block = compose.slice(start);
  return new Set([...block.matchAll(/^ {6}([A-Z][A-Z0-9_]*):/gm)].map((hit) => hit[1]));
}

function composeBuildArgs() {
  const start = compose.indexOf('\n      args:\n');
  expect(start, 'docker-compose.yml passes no build args').toBeGreaterThan(-1);
  const block = compose.slice(start, compose.indexOf('\n    restart:', start));
  return new Set([...block.matchAll(/^ {8}([A-Z][A-Z0-9_]*):/gm)].map((hit) => hit[1]));
}

describe('.env.example against the settings registry', () => {
  it('defines every variable an operator is expected to set, exactly once', () => {
    const counts = new Map<string, Definition[]>();
    for (const row of definitions) {
      const rows = counts.get(row.name) ?? [];
      rows.push(row);
      counts.set(row.name, rows);
    }
    const repeated = [...counts]
      .filter(([, rows]) => rows.length > 1)
      .map(([name, rows]) => `${name} on lines ${rows.map((row) => row.line).join(', ')}`);
    // dotenv builds an object, so a second definition silently wins. One variable, one line;
    // an alternative value belongs in the comment above it, where it cannot be loaded.
    expect(repeated, 'defined more than once').toEqual([]);
  });

  it('has a line for every registry env fallback', () => {
    const missing = PRIMARY_ENV.filter((name) => !defined.has(name));
    expect(missing, 'a field on /admin/config whose env fallback is undocumented').toEqual([]);
  });

  it('names every accepted alias, so nobody sets both spellings of one value', () => {
    const unmentioned = ALIAS_ENV.filter((name) => !example.includes(name));
    expect(unmentioned, 'accepted env alias not mentioned anywhere').toEqual([]);
  });

  it('has a line for every variable read before the database is reachable', () => {
    const missing = BOOTSTRAP_ENV_VARS.map((entry) => entry.name).filter(
      (name) => !PLATFORM_PROVIDED[name] && !defined.has(name),
    );
    expect(missing, 'a boot-time variable /admin/config shows read-only').toEqual([]);
  });

  it('documents nothing that no code and no compose file reads', () => {
    const sources: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
        if (entry.isDirectory()) walk(`${dir}/${entry.name}`);
        else if (/\.(?:ts|tsx|mjs)$/.test(entry.name)) sources.push(`${dir}/${entry.name}`);
      }
    };
    for (const dir of ['lib', 'app', 'scripts', 'prisma', 'tests']) walk(dir);
    sources.push('instrumentation.ts', 'docker-entrypoint.mjs', 'next.config.ts');

    const read = new Set<string>([...PRIMARY_ENV, ...ALIAS_ENV]);
    for (const rel of sources) {
      for (const hit of readText(rel).matchAll(
        /(?:process\.)?env(?:\.|\[')([A-Z][A-Z0-9_]{2,})/g,
      )) {
        read.add(hit[1]);
      }
    }
    // A compose file interpolating `${NAME}` is a reader too: POSTGRES_PASSWORD never appears
    // in application code, but the postgres service cannot start without it.
    for (const file of ['docker-compose.yml', 'docker-compose.dev.yml']) {
      for (const hit of readText(file).matchAll(/\$\{([A-Z][A-Z0-9_]*)/g)) {
        read.add(hit[1]);
      }
    }

    const orphans = [...defined].filter((name) => !read.has(name));
    expect(orphans, 'documented in .env.example, read by nothing').toEqual([]);
  });
});

describe('docker-compose.yml forwards what .env.example promises', () => {
  it('lists every registry env fallback under environment:', () => {
    const listed = composeRuntimeKeys();
    const missing = PRIMARY_ENV.filter((name) => !listed.has(name));
    // Coolify passes only the variables the compose file names. An unlisted one is set by the
    // operator, shown as unset by /admin/config, and used by nothing.
    expect(missing, 'registry env fallback not forwarded to the container').toEqual([]);
  });
});

describe('build-time values reach the build', () => {
  /**
   * `next build` replaces every `process.env.NEXT_PUBLIC_*` read with a literal, so a value
   * supplied under compose `environment:` reaches the Node process and never the browser
   * bundle. `NEXT_PUBLIC_APP_URL` shipped as `undefined` in the client chunks while
   * `assertInternalOrigin()` certified the runtime copy at boot, which is why it survived
   * (F-725).
   */
  function publicVarsReadInSource() {
    const found = new Set<string>();
    const walk = (dir: string) => {
      for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
        if (entry.isDirectory()) walk(`${dir}/${entry.name}`);
        else if (/\.(?:ts|tsx)$/.test(entry.name)) {
          for (const hit of readText(`${dir}/${entry.name}`).matchAll(
            /(?:process\.)?env(?:\.|\[')(NEXT_PUBLIC_[A-Z0-9_]+)/g,
          )) {
            found.add(hit[1]);
          }
        }
      }
    };
    for (const dir of ['lib', 'app', 'components', 'hooks']) walk(dir);
    return found;
  }

  /**
   * The one exemption, and it is checked rather than asserted: the quick-login buttons are
   * hard-disabled under NODE_ENV=production, which the production image always sets, so
   * passing this at build time could only mislead.
   */
  const PRODUCTION_INERT = 'NEXT_PUBLIC_DEV_QUICK_LOGIN';

  it('hard-disables the one public variable the production build omits', () => {
    const source = readText('lib', 'dev-quick-login.ts');
    expect(source).toContain(PRODUCTION_INERT);
    expect(source).toMatch(/NODE_ENV\s*===\s*["']production["']\)\s*return false/);
  });

  it('passes every other NEXT_PUBLIC_ value the app reads as a build arg', () => {
    const args = composeBuildArgs();
    const missing = [...publicVarsReadInSource()]
      .filter((name) => name !== PRODUCTION_INERT)
      .filter((name) => !args.has(name));
    expect(missing, 'inlined at build time but never passed to the build').toEqual([]);
  });

  it('declares each of those build args in the Dockerfile builder stage', () => {
    const dockerfile = readText('Dockerfile');
    const builder = dockerfile.slice(
      dockerfile.indexOf('FROM deps AS builder'),
      dockerfile.indexOf('FROM base AS runner'),
    );
    for (const name of composeBuildArgs()) {
      // ARG without the matching ENV is the silent half of the bug: the value arrives and
      // `next build` never sees it.
      expect(builder, `Dockerfile builder has no ARG ${name}`).toMatch(
        new RegExp(`^ARG ${name}`, 'm'),
      );
      if (name.startsWith('NEXT_PUBLIC_')) {
        expect(builder, `Dockerfile builder has no ENV ${name}`).toMatch(
          new RegExp(`^ENV ${name}=\\$\\{${name}\\}`, 'm'),
        );
      }
    }
  });

  it('fails the build when the required public origin is missing', () => {
    // There is no runtime recovery: by the time the app boots, the value is a literal in the
    // client chunks. The build is the last moment anything can object.
    const dockerfile = readText('Dockerfile');
    expect(dockerfile).toMatch(/RUN node -e "if\(!\(process\.env\.NEXT_PUBLIC_APP_URL/);
  });
});

describe('the development database is not on the network', () => {
  it('publishes Postgres on loopback only', () => {
    // `pnpm db:up` on a laptop on any shared network exposed the live working database —
    // real project content, user rows, AppSetting secrets — behind a guessable credential
    // (F-753). Without a bind address Docker publishes on 0.0.0.0.
    const dev = readText('docker-compose.dev.yml');
    const published = [...dev.matchAll(/^\s*- '([^']+)'/gm)].map((hit) => hit[1]);
    expect(published).toContain('127.0.0.1:5433:5432');
    expect(published, 'a port published on every interface').not.toContain('5433:5432');
  });
});
