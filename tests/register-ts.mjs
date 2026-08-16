import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

function tryTs(parentURL, specifier) {
  if (!parentURL || !specifier.startsWith('.')) return null;
  const parentDir = dirname(fileURLToPath(parentURL));
  const asTs = specifier.endsWith('.js')
    ? specifier.slice(0, -3) + '.ts'
    : specifier.endsWith('.ts')
      ? specifier
      : `${specifier}.ts`;
  const file = join(parentDir, asTs);
  return existsSync(file) ? pathToFileURL(file).href : null;
}

export async function resolve(specifier, context, nextResolve) {
  const mapped = tryTs(context.parentURL, specifier);
  if (mapped) {
    return { url: mapped, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
