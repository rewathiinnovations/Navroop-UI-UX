import { describe, expect, it } from 'vitest';
import { scanFilesForSecrets, scanTextForSecrets, shouldScanPath } from '../../lib/secret-scan';

describe('secret scanner hook', () => {
  it('blocks a private key', () => {
    const pem = ['-----BEGIN RSA PRIVATE KEY-----', 'MIIEowIBAAKCAQEA', '-----END RSA PRIVATE KEY-----'].join(
      '\n',
    );
    const findings = scanTextForSecrets(pem, 'tests/fixtures/secrets/id_rsa');
    expect(findings.some((row) => row.rule === 'pem-private-key')).toBe(true);
  });

  it('blocks a GitHub PAT and an AWS access key', () => {
    expect(scanTextForSecrets('token=ghp_abcdefghijklmnopqrstuvwxyz1234').length).toBeGreaterThan(0);
    expect(scanTextForSecrets('AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE').length).toBeGreaterThan(0);
  });

  it('does not flag ordinary source', () => {
    expect(scanTextForSecrets('export function hello() { return 1 }')).toEqual([]);
  });

  it('scans a file list the way the hook script does', () => {
    const findings = scanFilesForSecrets([
      {
        file: 'tmp/leak.pem',
        text: '-----BEGIN OPENSSH PRIVATE KEY-----\nb64\n-----END OPENSSH PRIVATE KEY-----',
      },
    ]);
    expect(findings[0]?.rule).toBe('pem-private-key');
  });

  it('flags a quoted generic secret assignment', () => {
    const findings = scanTextForSecrets('const api_key = "abcdefghijklmnopqrstuvwxyz"');
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
        text: '-----BEGIN EC PRIVATE KEY-----\nskip\n-----END EC PRIVATE KEY-----',
      },
      {
        file: 'tests/fixtures/secrets/leak.txt',
        text: 'password = "abcdefghijklmnopqrstuvwxyz"',
      },
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.file).toBe('tests/fixtures/secrets/leak.txt');
  });
});
