export const IMPORT_MODES = ['replicate', 'reimagine'] as const;

export type ImportMode = (typeof IMPORT_MODES)[number];

export const DEFAULT_IMPORT_MODE: ImportMode = 'reimagine';

export function isImportMode(value: unknown): value is ImportMode {
  return typeof value === 'string' && (IMPORT_MODES as readonly string[]).includes(value);
}

export function resolveImportMode(value: unknown): ImportMode {
  return isImportMode(value) ? value : DEFAULT_IMPORT_MODE;
}

export function parseDraftImportMode(value: unknown): ImportMode {
  if (!value || typeof value !== 'object') return DEFAULT_IMPORT_MODE;
  return resolveImportMode((value as { importMode?: unknown }).importMode);
}
