/**
 * Reads the current source tree out of the active sandbox and builds a
 * FileManifest from it.
 *
 * Extracted from GET /api/get-sandbox-files so the generation stream can call
 * it directly instead of over HTTP. The route is a thin wrapper.
 */
import { parseJavaScriptFile, buildComponentTree } from '@/lib/file-parser';
import type { FileManifest, FileInfo } from '@/types/file-manifest';
import { extractStackRoutes } from '@/lib/stacks/routes';
import {
  DEFAULT_STACK,
  getStack,
  getStackEntryPoint,
  getStackListExtensions,
  isStackId,
} from '@/lib/stacks';

declare global {
  var activeSandbox: any;
}

/** Files above this size are skipped: they are assets or lockfiles, not context. */
const MAX_READ_BYTES = 10000;

export type ReadSandboxFilesResult =
  | {
      ok: true;
      files: Record<string, string>;
      structure: string;
      fileCount: number;
      manifest: FileManifest;
    }
  | { ok: false; status: number; error: string };

function resolveListedStack(): string {
  const stored = (global as { sandboxData?: { stack?: unknown } }).sandboxData?.stack;
  if (typeof stored === 'string' && isStackId(stored)) {
    return getStack(stored).id;
  }
  return DEFAULT_STACK;
}

function findNameArgs(extensions: string[]): string[] {
  const args: string[] = ['('];
  extensions.forEach((ext, index) => {
    if (index > 0) args.push('-o');
    args.push('-name', `*${ext}`);
  });
  args.push(')');
  return args;
}

export async function readSandboxFiles(): Promise<ReadSandboxFilesResult> {
  if (!global.activeSandbox) {
    return { ok: false, status: 404, error: 'No active sandbox' };
  }

  try {
    const stack = resolveListedStack();
    const stackDef = getStack(stack);
    console.log('[get-sandbox-files] Fetching and analyzing file structure...', stackDef.id);

    const findResult = await global.activeSandbox.runCommand({
      cmd: 'find',
      args: [
        '.',
        '-name', 'node_modules', '-prune', '-o',
        '-name', '.git', '-prune', '-o',
        '-name', 'dist', '-prune', '-o',
        '-name', 'build', '-prune', '-o',
        '-type', 'f',
        ...findNameArgs(getStackListExtensions(stackDef.id)),
        '-print',
      ],
    });

    if (findResult.exitCode !== 0) {
      throw new Error('Failed to list files');
    }

    const fileList = (await findResult.stdout()).split('\n').filter((f: string) => f.trim());
    console.log('[get-sandbox-files] Found', fileList.length, 'files');

    const filesContent: Record<string, string> = {};

    for (const filePath of fileList) {
      try {
        const statResult = await global.activeSandbox.runCommand({
          cmd: 'stat',
          args: ['-f', '%z', filePath],
        });

        if (statResult.exitCode === 0) {
          const fileSize = parseInt(await statResult.stdout());

          if (fileSize < MAX_READ_BYTES) {
            const catResult = await global.activeSandbox.runCommand({
              cmd: 'cat',
              args: [filePath],
            });

            if (catResult.exitCode === 0) {
              const content = await catResult.stdout();
              const relativePath = filePath.replace(/^\.\//, '');
              filesContent[relativePath] = content;
            }
          }
        }
      } catch (parseError) {
        console.debug('Error parsing component info:', parseError);
        continue;
      }
    }

    const treeResult = await global.activeSandbox.runCommand({
      cmd: 'find',
      args: ['.', '-type', 'd', '-not', '-path', '*/node_modules*', '-not', '-path', '*/.git*'],
    });

    let structure = '';
    if (treeResult.exitCode === 0) {
      const dirs = (await treeResult.stdout()).split('\n').filter((d: string) => d.trim());
      structure = dirs.slice(0, 50).join('\n');
    }

    const fileManifest: FileManifest = {
      files: {},
      routes: [],
      componentTree: {},
      entryPoint: '',
      styleFiles: [],
      timestamp: Date.now(),
    };

    for (const [relativePath, content] of Object.entries(filesContent)) {
      const fullPath = `/${relativePath}`;

      const fileInfo: FileInfo = {
        content,
        type: 'utility',
        path: fullPath,
        relativePath,
        lastModified: Date.now(),
      };

      if (relativePath.match(/\.(jsx?|tsx?)$/)) {
        const parseResult = parseJavaScriptFile(content, fullPath);
        Object.assign(fileInfo, parseResult);

        if (relativePath === stackDef.entryPoint || relativePath === getStackEntryPoint(stackDef.id)) {
          fileManifest.entryPoint = fullPath;
        }
        if (stackDef.id === 'REACT') {
          if (relativePath === 'src/main.jsx' || relativePath === 'src/index.jsx') {
            fileManifest.entryPoint = fullPath;
          }
          if (relativePath === 'src/App.jsx' || relativePath === 'App.jsx') {
            fileManifest.entryPoint = fileManifest.entryPoint || fullPath;
          }
        }
      }

      if (relativePath.endsWith('.css')) {
        fileManifest.styleFiles.push(fullPath);
        fileInfo.type = 'style';
      }

      fileManifest.files[fullPath] = fileInfo;
    }

    fileManifest.componentTree = buildComponentTree(fileManifest.files);

    if (!fileManifest.entryPoint) {
      const entry = getStackEntryPoint(stackDef.id);
      if (filesContent[entry]) {
        fileManifest.entryPoint = `/${entry}`;
      }
    }

    fileManifest.routes = extractStackRoutes(stackDef.id, fileManifest.files);

    if (global.sandboxState?.fileCache) {
      global.sandboxState.fileCache.manifest = fileManifest;
    }

    return {
      ok: true,
      files: filesContent,
      structure,
      fileCount: Object.keys(filesContent).length,
      manifest: fileManifest,
    };
  } catch (error) {
    console.error('[get-sandbox-files] Error:', error);
    return { ok: false, status: 500, error: (error as Error).message };
  }
}
