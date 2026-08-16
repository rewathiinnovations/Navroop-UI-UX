import { NextResponse } from 'next/server';
import { parseJavaScriptFile, buildComponentTree } from '@/lib/file-parser';
import { FileManifest, FileInfo } from '@/types/file-manifest';
import { extractStackRoutes } from '@/lib/stacks/routes';
import {
  DEFAULT_STACK,
  getStack,
  getStackEntryPoint,
  getStackListExtensions,
  isStackId,
} from '@/lib/stacks';
// SandboxState type used implicitly through global.activeSandbox

declare global {
  var activeSandbox: any;
}

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

export async function GET() {
  try {
    if (!global.activeSandbox) {
      return NextResponse.json({
        success: false,
        error: 'No active sandbox'
      }, { status: 404 });
    }

    const stack = resolveListedStack();
    const stackDef = getStack(stack);
    console.log('[get-sandbox-files] Fetching and analyzing file structure...', stackDef.id);
    
    // Get list of all relevant files (extensions from the stack registry)
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
        '-print'
      ]
    });
    
    if (findResult.exitCode !== 0) {
      throw new Error('Failed to list files');
    }
    
    const fileList = (await findResult.stdout()).split('\n').filter((f: string) => f.trim());
    console.log('[get-sandbox-files] Found', fileList.length, 'files');
    
    // Read content of each file (limit to reasonable sizes)
    const filesContent: Record<string, string> = {};
    
    for (const filePath of fileList) {
      try {
        // Check file size first
        const statResult = await global.activeSandbox.runCommand({
          cmd: 'stat',
          args: ['-f', '%z', filePath]
        });
        
        if (statResult.exitCode === 0) {
          const fileSize = parseInt(await statResult.stdout());
          
          // Only read files smaller than 10KB
          if (fileSize < 10000) {
            const catResult = await global.activeSandbox.runCommand({
              cmd: 'cat',
              args: [filePath]
            });
            
            if (catResult.exitCode === 0) {
              const content = await catResult.stdout();
              // Remove leading './' from path
              const relativePath = filePath.replace(/^\.\//, '');
              filesContent[relativePath] = content;
            }
          }
        }
      } catch (parseError) {
        console.debug('Error parsing component info:', parseError);
        // Skip files that can't be read
        continue;
      }
    }
    
    // Get directory structure
    const treeResult = await global.activeSandbox.runCommand({
      cmd: 'find',
      args: ['.', '-type', 'd', '-not', '-path', '*/node_modules*', '-not', '-path', '*/.git*']
    });
    
    let structure = '';
    if (treeResult.exitCode === 0) {
      const dirs = (await treeResult.stdout()).split('\n').filter((d: string) => d.trim());
      structure = dirs.slice(0, 50).join('\n'); // Limit to 50 lines
    }
    
    // Build enhanced file manifest
    const fileManifest: FileManifest = {
      files: {},
      routes: [],
      componentTree: {},
      entryPoint: '',
      styleFiles: [],
      timestamp: Date.now(),
    };
    
    // Process each file
    for (const [relativePath, content] of Object.entries(filesContent)) {
      const fullPath = `/${relativePath}`;
      
      // Create base file info
      const fileInfo: FileInfo = {
        content: content,
        type: 'utility',
        path: fullPath,
        relativePath,
        lastModified: Date.now(),
      };
      
      // Parse JavaScript/JSX files
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
      
      // Track style files
      if (relativePath.endsWith('.css')) {
        fileManifest.styleFiles.push(fullPath);
        fileInfo.type = 'style';
      }
      
      fileManifest.files[fullPath] = fileInfo;
    }
    
    // Build component tree
    fileManifest.componentTree = buildComponentTree(fileManifest.files);
    
    if (!fileManifest.entryPoint) {
      const entry = getStackEntryPoint(stackDef.id);
      if (filesContent[entry]) {
        fileManifest.entryPoint = `/${entry}`;
      }
    }

    fileManifest.routes = extractStackRoutes(stackDef.id, fileManifest.files);
    
    // Update global file cache with manifest
    if (global.sandboxState?.fileCache) {
      global.sandboxState.fileCache.manifest = fileManifest;
    }

    return NextResponse.json({
      success: true,
      files: filesContent,
      structure,
      fileCount: Object.keys(filesContent).length,
      manifest: fileManifest,
    });

  } catch (error) {
    console.error('[get-sandbox-files] Error:', error);
    return NextResponse.json({
      success: false,
      error: (error as Error).message
    }, { status: 500 });
  }
}