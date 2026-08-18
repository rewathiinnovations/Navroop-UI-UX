import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The in-browser preview loads esbuild.wasm from /preview-vendor. The binary is
 * 12MB, so it is not committed — this copies it out of node_modules on install
 * and before every build, which keeps deploys self-contained.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'node_modules', 'esbuild-wasm', 'esbuild.wasm');
const targetDir = join(root, 'public', 'preview-vendor');
const target = join(targetDir, 'esbuild.wasm');

if (!existsSync(source)) {
  console.warn('[preview-vendor] esbuild-wasm not installed; skipping wasm copy');
  process.exit(0);
}

mkdirSync(targetDir, { recursive: true });
copyFileSync(source, target);
console.log('[preview-vendor] copied esbuild.wasm');
