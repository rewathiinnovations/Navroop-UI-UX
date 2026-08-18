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

const OVERRIDE_BANNER = '// navroop-preview-export-override — temporary, not user source';

export function nextConfigAlreadyExports(source: string) {
  return source.includes("output: 'export'") || source.includes('output: "export"');
}

/**
 * Whether the config is an ES module, and so cannot be appended to with `module.exports`.
 *
 * The NEXTJS scaffold writes `next.config.mjs` (`lib/stacks/templates/nextjs.ts`), which is
 * ESM by extension — `module` is not defined there. Appending CommonJS to it made every
 * static preview build die with `ReferenceError: module is not defined in ES module scope`,
 * so the preview fell back to LIVE_SANDBOX for every Next.js project ever generated.
 *
 * Decided on content rather than extension because `.js` is whichever the nearest
 * package.json says, and the config is the only file we have in hand.
 */
export function nextConfigIsEsm(source: string) {
  return /^\s*export\s+default\b/m.test(source) || /^\s*import\s+[^(]/m.test(source);
}

/** CommonJS: the original still evaluates, and the appended line re-exports it merged. */
export function wrapNextConfigForExport(original: string) {
  const trimmed = original.trim();
  if (nextConfigAlreadyExports(trimmed)) {
    return original;
  }
  return `${trimmed}\n\n${OVERRIDE_BANNER}\nmodule.exports = Object.assign({}, typeof module.exports === 'object' && module.exports ? module.exports : {}, { output: 'export' });\n`;
}

/**
 * Where the untouched ESM config is parked while the wrapper stands in for it.
 *
 * Same extension as the original, so Next's loader treats the two identically — a `.mjs`
 * sidecar for a `.mjs` config, a `.ts` sidecar for a `.ts` one.
 */
export function originalConfigSidecarPath(configPath: string) {
  return configPath.replace(/(\.[^./]+)$/, '.navroop-original$1');
}

/**
 * ESM cannot be appended to: a file may only have one default export, so the CommonJS trick
 * has no equivalent. The original is moved aside and imported by a wrapper instead.
 */
export function esmExportWrapper(sidecarPath: string) {
  const specifier = `./${sidecarPath.replace(/^\.?\//, '')}`;
  return `${OVERRIDE_BANNER}\nimport navroopBaseConfig from '${specifier}';\n\nexport default { ...navroopBaseConfig, output: 'export' };\n`;
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

  // Already exporting: nothing to add, and nothing to restore either.
  if (nextConfigAlreadyExports(original)) {
    return run();
  }

  if (!nextConfigIsEsm(original)) {
    try {
      await io.writeFile(configPath, wrapNextConfigForExport(original));
      return await run();
    } finally {
      await io.writeFile(configPath, original);
    }
  }

  const sidecar = originalConfigSidecarPath(configPath);
  try {
    await io.writeFile(sidecar, original);
    await io.writeFile(configPath, esmExportWrapper(sidecar));
    return await run();
  } finally {
    // The user's config comes back byte for byte, and the sidecar must not survive into a
    // checkpoint. `removeFile` is always provided by the sandbox adapter; the overwrite is
    // for a caller that cannot delete, where a stub is less wrong than a copy of the config.
    await io.writeFile(configPath, original);
    if (io.removeFile) {
      await io.removeFile(sidecar);
    } else {
      await io.writeFile(sidecar, `${OVERRIDE_BANNER}\nexport default {};\n`);
    }
  }
}

export const NEXT_CONFIG_CANDIDATES = ['next.config.js', 'next.config.mjs', 'next.config.ts'] as const;

export async function findNextConfigPath(listFiles: (dir: string) => Promise<string[]>) {
  const listed = await listFiles('.');
  const names = new Set(listed.map((path) => path.replace(/^\.?\//, '').split('/').pop() || path));
  return NEXT_CONFIG_CANDIDATES.find((name) => names.has(name)) ?? null;
}
