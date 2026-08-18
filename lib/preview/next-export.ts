const EXPORT_FAILURE_PATTERNS = [
  /getServerSideProps/i,
  /getInitialProps/i,
  /output:\s*['"]export['"]/i,
  /export is not supported/i,
  /cannot be exported/i,
  /app\/api/i,
  /API routes?/i,
  /i18n.*export/i,
  /rewrites.*export/i,
  /headers\(\).*export/i,
  /middleware.*export/i,
  /dynamic\s*=\s*['"]force-dynamic['"]/i,
  /server(?:-side)?\s+(?:feature|runtime|component)/i,
];

export function isNextExportFailure(log: string) {
  return EXPORT_FAILURE_PATTERNS.some((pattern) => pattern.test(log));
}

export function wrapNextConfigForExport(original: string) {
  const trimmed = original.trim();
  if (trimmed.includes("output: 'export'") || trimmed.includes('output: "export"')) {
    return original;
  }
  return `${trimmed}\n\n// navroop-preview-export-override — temporary, not user source\nmodule.exports = Object.assign({}, typeof module.exports === 'object' && module.exports ? module.exports : {}, { output: 'export' });\n`;
}

export type NextConfigIo = {
  readFile: (path: string) => Promise<string | Buffer>;
  writeFile: (path: string, content: string) => Promise<void>;
  removeFile?: (path: string) => Promise<void>;
};

/**
 * Temporarily set `output: 'export'` on the sandbox next.config, then restore
 * the exact original bytes. User source / checkpoints / publish are unaffected.
 */
export async function withTemporaryNextExport<T>(
  io: NextConfigIo,
  configPath: string,
  run: () => Promise<T>,
): Promise<T> {
  const originalRaw = await io.readFile(configPath);
  const original = typeof originalRaw === 'string' ? originalRaw : originalRaw.toString('utf8');
  try {
    await io.writeFile(configPath, wrapNextConfigForExport(original));
    return await run();
  } finally {
    await io.writeFile(configPath, original);
  }
}

export const NEXT_CONFIG_CANDIDATES = ['next.config.js', 'next.config.mjs', 'next.config.ts'] as const;

export async function findNextConfigPath(listFiles: (dir: string) => Promise<string[]>) {
  const listed = await listFiles('.');
  const names = new Set(listed.map((path) => path.replace(/^\.?\//, '').split('/').pop() || path));
  return NEXT_CONFIG_CANDIDATES.find((name) => names.has(name)) ?? null;
}
