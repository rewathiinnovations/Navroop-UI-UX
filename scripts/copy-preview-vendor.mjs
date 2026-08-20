import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * The in-browser preview loads esbuild.wasm from /preview-vendor. The binary is
 * 12MB, so it is not committed (`.gitignore:94`) — this copies it out of
 * node_modules before every build, which keeps deploys self-contained.
 *
 * A missing source is fatal, never a warning. `package.json` chains this ahead
 * of `next build` with `&&`, so exiting 0 here let a pruned or `--ignore-scripts`
 * install ship an image with no wasm binary: the compile step in the browser
 * cannot start, every project's preview pane fails, and the deploy that caused
 * it reported success (F-710).
 */

/** Copies the wasm binary into `<root>/public/preview-vendor`; throws if it is not installed. */
export function copyPreviewVendor(root) {
  const source = join(root, 'node_modules', 'esbuild-wasm', 'esbuild.wasm');
  const targetDir = join(root, 'public', 'preview-vendor');
  const target = join(targetDir, 'esbuild.wasm');

  if (!existsSync(source)) {
    throw new Error(
      `[preview-vendor] Missing ${source}\n` +
        '  The in-browser preview compiles every project with esbuild-wasm, so a build ' +
        'without this file ships a preview pane that can never render.\n' +
        '  It comes from the `esbuild-wasm` dependency: install dependencies for this ' +
        'checkout (pnpm install, without --ignore-scripts / --prod) and run the build again.',
    );
  }

  mkdirSync(targetDir, { recursive: true });
  copyFileSync(source, target);
  return target;
}

/** Process entry point, as an exit code, so the failure path is testable. */
export function main(root) {
  try {
    const target = copyPreviewVendor(root);
    console.log(`[preview-vendor] copied esbuild.wasm -> ${target}`);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) {
  process.exit(main(join(dirname(fileURLToPath(import.meta.url)), '..')));
}
