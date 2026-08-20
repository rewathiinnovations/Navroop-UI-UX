export type SecretFinding = {
  file: string;
  line: number;
  rule: string;
};

const RULES: Array<{ rule: string; re: RegExp }> = [
  { rule: 'pem-private-key', re: /-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/ },
  { rule: 'aws-access-key', re: /AKIA[0-9A-Z]{16}/ },
  // Classic, fine-grained, and app-installation GitHub tokens.
  { rule: 'github-pat', re: /\b(?:gh[oprsu]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/ },
  // The formats this app actually stores (F-729): DeepSeek/OpenAI/Anthropic
  // (all `sk-`), Google `AIza…`, Groq `gsk_…`, Firecrawl `fc-…`, Resend
  // `re_…_…`. GitHub App private keys are PEM blocks, covered above.
  { rule: 'provider-key-sk', re: /\bsk-[A-Za-z0-9_-]{20,}/ },
  { rule: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}/ },
  { rule: 'groq-api-key', re: /\bgsk_[A-Za-z0-9]{20,}/ },
  { rule: 'firecrawl-api-key', re: /\bfc-[A-Za-z0-9]{24,}/ },
  { rule: 'resend-api-key', re: /\bre_[A-Za-z0-9]+_[A-Za-z0-9]{16,}/ },
  // Cloudflare tokens have no distinctive prefix — 40 url-safe chars — so the
  // rule is contextual: the word appears near a quoted token-shaped value.
  { rule: 'cloudflare-api-token', re: /cloudflare.{0,40}['"][A-Za-z0-9_-]{40}['"]/i },
  {
    rule: 'generic-secret-assignment',
    re: /(?:api[_-]?key|secret|token|password)\s*[:=]\s*['"][A-Za-z0-9_\-/+=]{20,}['"]/i,
  },
];

// `.worktrees`, `.claude` and `.data` keep tree mode scanning this checkout
// only; `public/uploads` is user content, not source (F-729).
const IGNORE_PATH =
  /(^|\/)(node_modules|\.git|\.next|coverage|playwright-report|test-results|generated|\.worktrees|\.claude|\.data)\/|(^|\/)public\/uploads\//;

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
