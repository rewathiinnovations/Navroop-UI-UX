export type SecretFinding = {
  file: string;
  line: number;
  rule: string;
};

const RULES: Array<{ rule: string; re: RegExp }> = [
  { rule: 'pem-private-key', re: /-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/ },
  { rule: 'aws-access-key', re: /AKIA[0-9A-Z]{16}/ },
  { rule: 'github-pat', re: /ghp_[A-Za-z0-9]{20,}/ },
  { rule: 'generic-secret-assignment', re: /(?:api[_-]?key|secret|token|password)\s*[:=]\s*['"][A-Za-z0-9_\-/+=]{20,}['"]/i },
];

const IGNORE_PATH = /(^|\/)(node_modules|\.git|\.next|coverage|playwright-report|test-results|generated)\//;

export function scanTextForSecrets(text: string, file = 'memory') {
  const findings: SecretFinding[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const { rule, re } of RULES) {
      if (re.test(line)) {
        findings.push({ file, line: index + 1, rule });
      }
    }
  });
  return findings;
}

export function shouldScanPath(file: string) {
  const normalized = file.replace(/\\/g, '/');
  if (IGNORE_PATH.test(normalized)) return false;
  if (normalized.endsWith('docs/verify-bypasses.log')) return false;
  if (normalized.includes('tests/fixtures/secrets/')) return true;
  return true;
}

export function scanFilesForSecrets(files: Array<{ file: string; text: string }>) {
  return files.flatMap((row) =>
    shouldScanPath(row.file) ? scanTextForSecrets(row.text, row.file) : [],
  );
}
