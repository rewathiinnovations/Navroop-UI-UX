import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scanFilesForSecrets, scanTextForSecrets, shouldScanPath } from '../../lib/secret-scan';

const REPO = resolve(import.meta.dirname, '..', '..');
const TSX = join(REPO, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const SCRIPT = join(REPO, 'scripts', 'secret-scan.ts');

function runScanner(args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  const result = spawnSync('node', [TSX, SCRIPT, ...args], {
    cwd: options.cwd ?? REPO,
    env: options.env ?? process.env,
    encoding: 'utf8',
  });
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

describe('secret scanner hook', () => {
  it('blocks a private key', () => {
    const pem = [
      ['-----BEGIN RSA', ' PRIVATE KEY-----'].join(''),
      'MIIEowIBAAKCAQEA',
      ['-----END RSA', ' PRIVATE KEY-----'].join(''),
    ].join('\n');
    const findings = scanTextForSecrets(pem, 'tests/fixtures/secrets/id_rsa');
    expect(findings.some((row) => row.rule === 'pem-private-key')).toBe(true);
  });

  it('blocks a GitHub PAT and an AWS access key', () => {
    expect(
      scanTextForSecrets('token=' + ['ghp_', 'abcdefghijklmnopqrstuvwxyz1234'].join('')).length,
    ).toBeGreaterThan(0);
    expect(
      scanTextForSecrets('AWS_ACCESS_KEY_ID=' + ['AKIA', 'IOSFODNN7EXAMPLE'].join('')).length,
    ).toBeGreaterThan(0);
  });

  it('does not flag ordinary source', () => {
    expect(scanTextForSecrets('export function hello() { return 1 }')).toEqual([]);
  });

  it('scans a file list the way the hook script does', () => {
    const findings = scanFilesForSecrets([
      {
        file: 'tmp/leak.pem',
        text: ['-----BEGIN OPENSSH', ' PRIVATE KEY-----'].join('') + '\nb64',
      },
    ]);
    expect(findings[0]?.rule).toBe('pem-private-key');
  });

  it('flags a quoted generic secret assignment', () => {
    const findings = scanTextForSecrets('const api_key = "' + 'abcdefghijklmnopqrstuvwxyz' + '"');
    expect(findings.some((row) => row.rule === 'generic-secret-assignment')).toBe(true);
  });

  it('skips ignored trees, bypass log, and still scans fixture secrets', () => {
    expect(shouldScanPath('node_modules/foo/secret.ts')).toBe(false);
    expect(shouldScanPath('app\\.next\\cache\\x')).toBe(false);
    expect(shouldScanPath('docs/verify-bypasses.log')).toBe(false);
    expect(shouldScanPath('tests/fixtures/secrets/id_rsa')).toBe(true);
    expect(shouldScanPath('lib/secret-scan.ts')).toBe(true);

    const findings = scanFilesForSecrets([
      {
        file: 'coverage/lcov.info',
        text: ['-----BEGIN EC', ' PRIVATE KEY-----'].join('') + '\nskip',
      },
      {
        file: 'tests/fixtures/secrets/leak.txt',
        text: 'password = "' + 'abcdefghijklmnopqrstuvwxyz' + '"',
      },
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.file).toBe('tests/fixtures/secrets/leak.txt');
  });

  // Fixtures are assembled from parts so this file never contains a
  // contiguous string the scanner itself (or the staged-file hook) would flag.
  it('blocks the provider key formats this app actually uses (F-729)', () => {
    const cases: Array<{ rule: string; text: string }> = [
      {
        rule: 'provider-key-sk',
        text: 'DEEPSEEK_API_KEY=' + ['sk-', '0123456789abcdef0123456789abcdef'].join(''),
      },
      {
        rule: 'provider-key-sk',
        text: 'const anthropicish = ' + ['sk-', 'ant-api03-abcdefghijklmnopqrstuvwxyz'].join(''),
      },
      {
        rule: 'google-api-key',
        text: 'GEMINI_API_KEY=' + ['AIza', 'SyA0123456789abcdefghijklmnopqrstuv'].join(''),
      },
      {
        rule: 'groq-api-key',
        text: 'GROQ_API_KEY=' + ['gsk_', 'abcdefghijklmnopqrstuvwxyz012345'].join(''),
      },
      {
        rule: 'github-pat',
        text: ['github_pat_', '11ABCDEFG0123456789abcdefghijklmnopqrstuvwxyz'].join(''),
      },
      {
        rule: 'github-pat',
        text: ['ghs_', 'abcdefghijklmnopqrstuvwxyz012345'].join(''),
      },
      {
        rule: 'firecrawl-api-key',
        text: 'FIRECRAWL_API_KEY=' + ['fc-', '0123456789abcdef0123456789abcdef'].join(''),
      },
      {
        rule: 'resend-api-key',
        text: ['re_', 'AbCdEfGh_', '0123456789abcdefghijkl'].join(''),
      },
      {
        rule: 'cloudflare-api-token',
        text:
          'cloudflare token: "' + ['AbCdEfGhIjKlMnOpQrStUvWxYz', '0123456789-_ab'].join('') + '"',
      },
    ];

    for (const row of cases) {
      const findings = scanTextForSecrets(row.text);
      expect(
        findings.some((finding) => finding.rule === row.rule),
        `${row.rule} should match: ${row.text.slice(0, 24)}…`,
      ).toBe(true);
    }
  });

  it('does not flag prose or short prefixes that merely resemble provider keys', () => {
    expect(scanTextForSecrets('the sk- prefix marks DeepSeek keys')).toEqual([]);
    expect(scanTextForSecrets('re_render the page after saving')).toEqual([]);
    expect(scanTextForSecrets('AIza is how Google keys begin')).toEqual([]);
    expect(scanTextForSecrets('cloudflare zone lookup failed')).toEqual([]);
  });

  it('ignores sibling worktrees, agent state, and uploads in tree mode (F-729)', () => {
    expect(shouldScanPath('.worktrees/other-branch/lib/settings/registry.ts')).toBe(false);
    expect(shouldScanPath('.claude/session-state.json')).toBe(false);
    expect(shouldScanPath('.data/state/volume-id')).toBe(false);
    expect(shouldScanPath('public/uploads/import-4711/asset.svg')).toBe(false);
    expect(shouldScanPath('lib/settings/registry.ts')).toBe(true);
  });

  /**
   * F-785. The `verify` gate's `secret-scan` step runs `--tracked`. These drive the
   * real script, because the whole point of the step is that the *command* works on
   * a developer machine: the default whole-tree mode reads `.env.local` on purpose
   * and reports its real keys, so wiring that mode into a gate would have produced
   * a step nobody could ever get green.
   */
  describe('the tracked mode the verify gate runs', () => {
    it('scans the tracked tree of this repository and exits 0', () => {
      const { status, output } = runScanner(['--tracked']);
      const scanned = /Secret scan passed \((\d+) file/.exec(output);
      expect(output).not.toContain('Nothing to scan');
      expect(Number(scanned?.[1] ?? 0)).toBeGreaterThan(500);
      expect(status).toBe(0);
    });

    it('exits 2, not 0, when it cannot enumerate the tracked files', () => {
      // Fails closed: git cannot answer, so nothing was examined, so the scan
      // cannot report a pass. Exit 1 would be wrong too — there is no finding, the
      // gate is broken, and the two need different reactions.
      const dir = mkdtempSync(join(tmpdir(), 'navroop-secret-scan-'));
      const { status, output } = runScanner(['--tracked'], {
        cwd: dir,
        env: { ...process.env, GIT_DIR: join(dir, 'absent.git') },
      });
      expect(status).toBe(2);
      expect(output).toContain('could not list the tracked files');
      expect(output).not.toContain('Secret scan passed');
    });
  });
});
