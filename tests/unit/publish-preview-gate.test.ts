import { createHash, timingSafeEqual } from 'node:crypto';
import { transformSync } from 'esbuild';
import { describe, expect, it } from 'vitest';
import { injectPreviewFiles } from '@/lib/publish/preview-inject';

/**
 * The preview password gate, exercised rather than described.
 *
 * The gate is source text emitted into someone else's repository, so nothing in this
 * repo ever runs it — which is how it kept `password !== expected` (a comparison that
 * stops at the first differing byte and therefore leaks the password's length and then
 * its prefix to a remote attacker, one request at a time) and how it kept ignoring the
 * Basic-auth username entirely (F-231).
 *
 * So these cases lift the emitted helper out of the generated `middleware.ts`, transpile
 * it and call it. The helper is fenced by `navroop-preview-auth` marker comments for
 * exactly this reason: an assertion on generated code that only greps for a substring
 * cannot tell a working gate from a broken one.
 */

const AUTH_BLOCK = /\/\/ navroop-preview-auth:start\n([\s\S]*?)\/\/ navroop-preview-auth:end/;

const PASSWORD = ['open', 'sesame', 'please'].join('-');

function loadGate(middleware: string) {
  const block = AUTH_BLOCK.exec(middleware);
  if (!block) throw new Error('the emitted middleware carries no navroop-preview-auth block');
  const js = transformSync(block[1], { loader: 'ts', format: 'cjs' }).code;
  const factory = new Function(
    'createHash',
    'timingSafeEqual',
    `${js}\nreturn previewCredentialsOk;`,
  ) as (
    hash: typeof createHash,
    equal: typeof timingSafeEqual,
  ) => (header: string | null, expected: string) => boolean;
  return factory(createHash, timingSafeEqual);
}

function basic(user: string, password: string) {
  return `Basic ${Buffer.from(`${user}:${password}`, 'utf8').toString('base64')}`;
}

const protectedMiddleware = () =>
  injectPreviewFiles(
    { 'app/page.tsx': 'export default function Page(){return null}' },
    { stack: 'NEXTJS', deployType: 'node', passwordProtected: true },
  )['middleware.ts'];

describe('the emitted preview gate accepts exactly one credential pair', () => {
  it('accepts the preview account with the deployed password', () => {
    const ok = loadGate(protectedMiddleware());

    expect(ok(basic('preview', PASSWORD), PASSWORD)).toBe(true);
  });

  it('rejects the right password under a different username', () => {
    // The gate used to split on ':' and throw the username away, so `anything:<password>`
    // opened the preview. The static-stack preview has always required `preview` (Traefik
    // basic auth is configured with that account), and the two gates must agree.
    const ok = loadGate(protectedMiddleware());

    expect(ok(basic('admin', PASSWORD), PASSWORD)).toBe(false);
    expect(ok(basic('', PASSWORD), PASSWORD)).toBe(false);
  });

  it('rejects a wrong password, including a correct prefix and the empty string', () => {
    const ok = loadGate(protectedMiddleware());

    expect(ok(basic('preview', PASSWORD.slice(0, -1)), PASSWORD)).toBe(false);
    expect(ok(basic('preview', `${PASSWORD}x`), PASSWORD)).toBe(false);
    expect(ok(basic('preview', ''), PASSWORD)).toBe(false);
  });

  it('rejects a credential with no colon rather than reading it as a bare password', () => {
    const ok = loadGate(protectedMiddleware());

    const encoded = Buffer.from(PASSWORD, 'utf8').toString('base64');
    expect(ok(`Basic ${encoded}`, PASSWORD)).toBe(false);
  });

  it('rejects a missing, empty or non-Basic Authorization header', () => {
    const ok = loadGate(protectedMiddleware());

    expect(ok(null, PASSWORD)).toBe(false);
    expect(ok('', PASSWORD)).toBe(false);
    expect(ok('Bearer abc', PASSWORD)).toBe(false);
    expect(ok('Basic', PASSWORD)).toBe(false);
  });

  it('survives credentials of a different byte length without throwing', () => {
    // `timingSafeEqual` throws on unequal lengths, so a gate that fed it raw credentials
    // would 500 on a short password instead of answering 401. Hashing both sides first is
    // what makes the comparison total as well as constant-time.
    const ok = loadGate(protectedMiddleware());

    expect(() => ok(basic('preview', 'x'), PASSWORD)).not.toThrow();
    expect(ok(basic('preview', 'x'), PASSWORD)).toBe(false);
    expect(() => ok(basic('a'.repeat(500), 'y'.repeat(500)), PASSWORD)).not.toThrow();
  });

  it('handles non-ASCII passwords byte-for-byte', () => {
    // `atob` yields latin1, so a password with an accent decoded to different bytes than
    // the one the operator typed and the gate refused its own credentials.
    const ok = loadGate(protectedMiddleware());

    const accented = 'passord-æøå';
    expect(ok(basic('preview', accented), accented)).toBe(true);
    expect(ok(basic('preview', 'passord-aoa'), accented)).toBe(false);
  });
});

describe('the emitted preview gate is constant-time by construction', () => {
  it('never compares the credentials with === or !==', () => {
    const middleware = protectedMiddleware();
    const block = AUTH_BLOCK.exec(middleware)?.[1] ?? '';

    expect(block).toContain('timingSafeEqual');
    // A byte-by-byte comparison anywhere near the secret defeats the point.
    expect(block).not.toMatch(/(password|expected|user)\s*[!=]==/);
    expect(block).not.toMatch(/[!=]==\s*(password|expected|PREVIEW_USER)\b/);
  });

  it('runs the gate on the Node.js runtime so node:crypto is available', () => {
    const middleware = protectedMiddleware();

    expect(middleware).toContain("from 'node:crypto'");
    // Middleware defaults to the Edge runtime, which has no node:crypto at all — without
    // this the generated project fails to build.
    expect(middleware).toContain("runtime: 'nodejs'");
  });

  it('emits neither the crypto import nor the runtime pin when there is no gate', () => {
    const files = injectPreviewFiles(
      { 'app/page.tsx': 'export default function Page(){return null}' },
      { stack: 'NEXTJS', deployType: 'node', passwordProtected: false },
    );

    expect(files['middleware.ts']).not.toContain('node:crypto');
    expect(files['middleware.ts']).not.toContain('navroop-preview-auth');
    expect(files['middleware.ts']).toContain('X-Robots-Tag');
  });
});

describe('a project that has its own middleware still gets the real gate', () => {
  it('wraps the project middleware and keeps the constant-time check', () => {
    const files = injectPreviewFiles(
      {
        'app/page.tsx': 'export default function Page(){return null}',
        'middleware.ts': `import { NextResponse } from 'next/server';
export function middleware() {
  return NextResponse.next();
}
`,
      },
      { stack: 'NEXTJS', deployType: 'node', passwordProtected: true },
    );

    const wrapper = files['middleware.ts'];
    const ok = loadGate(wrapper);
    expect(ok(basic('preview', PASSWORD), PASSWORD)).toBe(true);
    expect(ok(basic('someone-else', PASSWORD), PASSWORD)).toBe(false);
    // Still fail-closed and still upstream of the project's own handler.
    expect(wrapper.indexOf('previewCredentialsOk(')).toBeLessThan(
      wrapper.indexOf('await run(request)'),
    );
  });
});
