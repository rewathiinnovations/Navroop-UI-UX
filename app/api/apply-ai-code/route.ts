import { NextRequest, NextResponse } from 'next/server';
import { parseMorphEdits, applyMorphEditToFile, isMorphConfigured } from '@/lib/morph-fast-apply';
import { resolveRequestStack } from '@/lib/stack-resolve';
import type { SandboxState } from '@/types/sandbox';
import type { ConversationState } from '@/types/conversation';
import { jsonError } from '@/lib/api/error-response';
import { requireSessionUser } from '@/lib/auth';
import { detectAndInstallPackages } from '@/lib/sandbox/detect-packages';
import { installPackages } from '@/lib/sandbox/install-packages';
import { restartDevServer } from '@/lib/sandbox/restart-dev';
import { applyOutcome } from '@/lib/jobs/copy';

declare global {
  var conversationState: ConversationState | null;
}

interface ParsedResponse {
  explanation: string;
  template: string;
  files: Array<{ path: string; content: string }>;
  packages: string[];
  commands: string[];
  structure: string | null;
}

function parseAIResponse(response: string): ParsedResponse {
  const sections = {
    files: [] as Array<{ path: string; content: string }>,
    commands: [] as string[],
    packages: [] as string[],
    structure: null as string | null,
    explanation: '',
    template: ''
  };

  // Parse file sections - handle duplicates and prefer complete versions
  const fileMap = new Map<string, { content: string; isComplete: boolean }>();
  
  const fileRegex = /<file path="([^"]+)">([\s\S]*?)(?:<\/file>|$)/g;
  let match;
  while ((match = fileRegex.exec(response)) !== null) {
    const filePath = match[1];
    const content = match[2].trim();
    const hasClosingTag = response.substring(match.index, match.index + match[0].length).includes('</file>');
    
    // Check if this file already exists in our map
    const existing = fileMap.get(filePath);
    
    // Decide whether to keep this version
    let shouldReplace = false;
    if (!existing) {
      shouldReplace = true; // First occurrence
    } else if (!existing.isComplete && hasClosingTag) {
      shouldReplace = true; // Replace incomplete with complete
      console.log(`[parseAIResponse] Replacing incomplete ${filePath} with complete version`);
    } else if (existing.isComplete && hasClosingTag && content.length > existing.content.length) {
      shouldReplace = true; // Replace with longer complete version
      console.log(`[parseAIResponse] Replacing ${filePath} with longer complete version`);
    } else if (!existing.isComplete && !hasClosingTag && content.length > existing.content.length) {
      shouldReplace = true; // Both incomplete, keep longer one
    }
    
    if (shouldReplace) {
      // Additional validation: reject obviously broken content
      if (content.includes('...') && !content.includes('...props') && !content.includes('...rest')) {
        console.warn(`[parseAIResponse] Warning: ${filePath} contains ellipsis, may be truncated`);
        // Still use it if it's the only version we have
        if (!existing) {
          fileMap.set(filePath, { content, isComplete: hasClosingTag });
        }
      } else {
        fileMap.set(filePath, { content, isComplete: hasClosingTag });
      }
    }
  }
  
  // Convert map to array for sections.files
  for (const [path, { content, isComplete }] of fileMap.entries()) {
    if (!isComplete) {
      console.log(`[parseAIResponse] Warning: File ${path} appears to be truncated (no closing tag)`);
    }
    
    sections.files.push({
      path,
      content
    });
  }

  // Parse commands
  const cmdRegex = /<command>(.*?)<\/command>/g;
  while ((match = cmdRegex.exec(response)) !== null) {
    sections.commands.push(match[1].trim());
  }

  // Parse packages - support both <package> and <packages> tags
  const pkgRegex = /<package>(.*?)<\/package>/g;
  while ((match = pkgRegex.exec(response)) !== null) {
    sections.packages.push(match[1].trim());
  }
  
  // Also parse <packages> tag with multiple packages
  const packagesRegex = /<packages>([\s\S]*?)<\/packages>/;
  const packagesMatch = response.match(packagesRegex);
  if (packagesMatch) {
    const packagesContent = packagesMatch[1].trim();
    // Split by newlines or commas
    const packagesList = packagesContent.split(/[\n,]+/)
      .map(pkg => pkg.trim())
      .filter(pkg => pkg.length > 0);
    sections.packages.push(...packagesList);
  }

  // Parse structure
  const structureMatch = /<structure>([\s\S]*?)<\/structure>/;
  const structResult = response.match(structureMatch);
  if (structResult) {
    sections.structure = structResult[1].trim();
  }

  // Parse explanation
  const explanationMatch = /<explanation>([\s\S]*?)<\/explanation>/;
  const explResult = response.match(explanationMatch);
  if (explResult) {
    sections.explanation = explResult[1].trim();
  }

  // Parse template
  const templateMatch = /<template>(.*?)<\/template>/;
  const templResult = response.match(templateMatch);
  if (templResult) {
    sections.template = templResult[1].trim();
  }

  return sections;
}

declare global {
  var activeSandbox: any;
  var activeSandboxProvider: any;
  var existingFiles: Set<string>;
  var sandboxState: SandboxState;
}

export async function POST(request: NextRequest) {
  const auth = await requireSessionUser();
  if (!auth.user) return jsonError(auth.error, 'UNAUTHORIZED', auth.status);

  try {
    const {
      response,
      isEdit = false,
      packages = [],
      stack: requestStack,
      projectId,
    } = await request.json();

    if (!response) {
      return NextResponse.json({
        error: 'response is required'
      }, { status: 400 });
    }

    const storedStack =
      typeof (global as { sandboxData?: { stack?: unknown } }).sandboxData?.stack === 'string'
        ? (global as { sandboxData?: { stack?: string } }).sandboxData?.stack
        : undefined;
    const activeStack = await resolveRequestStack({
      stack: requestStack ?? storedStack,
      projectId,
    });

    // Parse the AI response
    const parsed = parseAIResponse(response);
    const morphEnabled = Boolean(isEdit && (await isMorphConfigured()));
    const morphEdits = morphEnabled ? parseMorphEdits(response) : [];
    console.log('[apply-ai-code] Morph Fast Apply mode:', morphEnabled);
    if (morphEnabled) {
      console.log('[apply-ai-code] Morph edits found:', morphEdits.length);
    }
    
    // Initialize existingFiles if not already
    if (!global.existingFiles) {
      global.existingFiles = new Set<string>();
    }
    
    // Get the active sandbox or provider
    const sandbox = global.activeSandbox || global.activeSandboxProvider;
    
    // If no active sandbox, just return parsed results
    if (!sandbox) {
      return NextResponse.json({
        success: true,
        results: {
          filesCreated: parsed.files.map(f => f.path),
          packagesInstalled: parsed.packages,
          commandsExecuted: parsed.commands,
          errors: []
        },
        explanation: parsed.explanation,
        structure: parsed.structure,
        parsedFiles: parsed.files,
        message: `Parsed ${parsed.files.length} files successfully. Create a sandbox to apply them.`
      });
    }
    
    // Verify sandbox is ready before applying code
    console.log('[apply-ai-code] Verifying sandbox is ready...');
    
    // Apply to active sandbox
    console.log('[apply-ai-code] Applying code to sandbox...');
    console.log('[apply-ai-code] Is edit mode:', isEdit);
    console.log('[apply-ai-code] Files to write:', parsed.files.map(f => f.path));
    console.log('[apply-ai-code] Existing files:', Array.from(global.existingFiles));
    if (morphEnabled) {
      console.log('[apply-ai-code] Morph Fast Apply enabled');
      if (morphEdits.length > 0) {
        console.log('[apply-ai-code] Parsed Morph edits:', morphEdits.map(e => e.targetFile));
      } else {
        console.log('[apply-ai-code] No <edit> blocks found in response');
      }
    }
    
    const results = {
      filesCreated: [] as string[],
      filesUpdated: [] as string[],
      packagesInstalled: [] as string[],
      packagesAlreadyInstalled: [] as string[],
      packagesFailed: [] as string[],
      commandsExecuted: [] as string[],
      errors: [] as string[]
    };
    
    // Combine packages from tool calls and parsed XML tags
    const allPackages = [...packages.filter((pkg: any) => pkg && typeof pkg === 'string'), ...parsed.packages];
    const uniquePackages = [...new Set(allPackages)]; // Remove duplicates
    
    if (uniquePackages.length > 0) {
      console.log('[apply-ai-code] Installing packages from XML tags and tool calls:', uniquePackages);
      
      try {
        const installResult = await installPackages({ packages: uniquePackages });
        console.log('[apply-ai-code] Package installation result:', installResult);

        if (installResult.ok) {
          results.packagesInstalled = installResult.installedPackages;
          results.packagesAlreadyInstalled = installResult.alreadyInstalled;
          if (!installResult.previewReady && installResult.previewNotice) {
            results.errors.push(installResult.previewNotice);
          }
        } else {
          // Log and continue. Packages are installed before any file is
          // written, so aborting here would discard a generation the user
          // already paid for and leave the sandbox untouched. Writing the files
          // and surfacing the failure lets them retry the install alone.
          console.error('[apply-ai-code] Package installation failed:', installResult.error);
          results.packagesFailed = uniquePackages;
          results.errors.push(`Package installation failed: ${installResult.error}`);
        }
      } catch (error) {
        console.error('[apply-ai-code] Error installing packages:', error);
        results.errors.push(`Package installation failed: ${(error as Error).message}`);
      }
    } else {
      // Fallback to detecting packages from code
      console.log('[apply-ai-code] No packages provided, detecting from generated code...');
      console.log('[apply-ai-code] Number of files to scan:', parsed.files.length);
      
      // Filter out config files first
      const configFiles = ['tailwind.config.js', 'vite.config.js', 'package.json', 'package-lock.json', 'tsconfig.json', 'postcss.config.js'];
      const filteredFilesForDetection = parsed.files.filter(file => {
        const fileName = file.path.split('/').pop() || '';
        return !configFiles.includes(fileName);
      });
      
      // Build files object for package detection
      const filesForPackageDetection: Record<string, string> = {};
      for (const file of filteredFilesForDetection) {
        filesForPackageDetection[file.path] = file.content;
        // Log if heroicons is found
        if (file.content.includes('heroicons')) {
          console.log(`[apply-ai-code] Found heroicons import in ${file.path}`);
        }
      }
      
      try {
        console.log('[apply-ai-code] Detecting packages from generated code...');
        const packageResult = await detectAndInstallPackages({ files: filesForPackageDetection });

        if (packageResult.ok) {
          console.log('[apply-ai-code] Package installation result:', JSON.stringify(packageResult, null, 2));
        
        if (packageResult.packagesInstalled && packageResult.packagesInstalled.length > 0) {
          results.packagesInstalled = packageResult.packagesInstalled;
          console.log(`[apply-ai-code] Installed packages: ${packageResult.packagesInstalled.join(', ')}`);
        }
        
        if (packageResult.packagesAlreadyInstalled && packageResult.packagesAlreadyInstalled.length > 0) {
          results.packagesAlreadyInstalled = packageResult.packagesAlreadyInstalled;
          console.log(`[apply-ai-code] Already installed: ${packageResult.packagesAlreadyInstalled.join(', ')}`);
        }
        
        if (packageResult.packagesFailed && packageResult.packagesFailed.length > 0) {
          results.packagesFailed = packageResult.packagesFailed;
          console.error(`[apply-ai-code] Failed to install packages: ${packageResult.packagesFailed.join(', ')}`);
          results.errors.push(`Failed to install packages: ${packageResult.packagesFailed.join(', ')}`);
        }
        
        // Force Vite restart after package installation
        if (results.packagesInstalled.length > 0) {
          console.log('[apply-ai-code] Packages were installed, forcing Vite restart...');
          
          try {
            const restartResult = await restartDevServer();
            if (restartResult.ok) {
              console.log('[apply-ai-code] Vite restart result:', restartResult.message);
            } else {
              // Log and continue. The packages are installed and the files are
              // about to be written; a stale dev server shows the user an old
              // preview, which the next write or a manual refresh corrects.
              console.error('[apply-ai-code] Failed to restart Vite:', restartResult.error);
              results.errors.push(`Failed to restart the dev server: ${restartResult.error}`);
            }
          } catch (e) {
            console.error('[apply-ai-code] Error restarting the dev server:', e);
            results.errors.push(`Failed to restart the dev server: ${(e as Error).message}`);
          }
          
          // Additional delay to ensure files can be written after restart
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
        } else {
          // Log and continue: the same trade-off as the explicit package list
          // above. Files are still worth writing.
          console.error('[apply-ai-code] Package detection/installation failed:', packageResult.error);
          results.errors.push(`Package detection failed: ${packageResult.error}`);
        }
      } catch (error) {
        console.error('[apply-ai-code] Error detecting/installing packages:', error);
        results.errors.push(`Package detection failed: ${(error as Error).message}`);
      }
    }
    
    // Attempt Morph Fast Apply for edits before file creation
    const morphUpdatedPaths = new Set<string>();

    if (morphEnabled && morphEdits.length > 0) {
      if (!global.activeSandbox) {
        console.warn('[apply-ai-code] Morph edits found but no active sandbox; skipping Morph application');
      } else {
        console.log(`[apply-ai-code] Applying ${morphEdits.length} fast edits via Morph...`);
        for (const edit of morphEdits) {
          try {
            const result = await applyMorphEditToFile({
              sandbox: global.activeSandbox,
              targetPath: edit.targetFile,
              instructions: edit.instructions,
              updateSnippet: edit.update,
              stack: activeStack
            });

            if (result.success && result.normalizedPath) {
              morphUpdatedPaths.add(result.normalizedPath);
              results.filesUpdated.push(result.normalizedPath);
              console.log('[apply-ai-code] Morph applied to', result.normalizedPath);
            } else {
              const msg = result.error || 'Unknown Morph error';
              console.error('[apply-ai-code] Morph apply failed:', msg);
              results.errors.push(`Morph apply failed for ${edit.targetFile}: ${msg}`);
            }
          } catch (e) {
            console.error('[apply-ai-code] Morph apply exception:', e);
            results.errors.push(`Morph apply exception for ${edit.targetFile}: ${(e as Error).message}`);
          }
        }
      }
    }
    if (morphEnabled && morphEdits.length === 0) {
      console.warn('[apply-ai-code] Morph enabled but no <edit> blocks found; falling back to full-file flow');
    }

    // Filter out config files that shouldn't be created
    const configFiles = ['tailwind.config.js', 'vite.config.js', 'package.json', 'package-lock.json', 'tsconfig.json', 'postcss.config.js'];
    let filteredFiles = parsed.files.filter(file => {
      const fileName = file.path.split('/').pop() || '';
      if (configFiles.includes(fileName)) {
        console.warn(`[apply-ai-code] Skipping config file: ${file.path} - already exists in template`);
        return false;
      }
      return true;
    });

    // Avoid overwriting files already updated by Morph
    if (morphUpdatedPaths.size > 0) {
      filteredFiles = filteredFiles.filter(file => {
        let normalizedPath = file.path.startsWith('/') ? file.path.slice(1) : file.path;
        const fileName = normalizedPath.split('/').pop() || '';
        if (!normalizedPath.startsWith('src/') &&
            !normalizedPath.startsWith('public/') &&
            normalizedPath !== 'index.html' &&
            !configFiles.includes(fileName)) {
          normalizedPath = 'src/' + normalizedPath;
        }
        return !morphUpdatedPaths.has(normalizedPath);
      });
    }
    
    // Create or update files AFTER package installation
    for (const file of filteredFiles) {
      try {
        // Normalize the file path
        let normalizedPath = file.path;
        // Remove leading slash if present
        if (normalizedPath.startsWith('/')) {
          normalizedPath = normalizedPath.substring(1);
        }
        // Ensure src/ prefix for component files
        if (!normalizedPath.startsWith('src/') && 
            !normalizedPath.startsWith('public/') && 
            normalizedPath !== 'index.html' && 
            normalizedPath !== 'package.json' &&
            normalizedPath !== 'vite.config.js' &&
            normalizedPath !== 'tailwind.config.js' &&
            normalizedPath !== 'postcss.config.js') {
          normalizedPath = 'src/' + normalizedPath;
        }
        
        const fullPath = `/home/user/app/${normalizedPath}`;
        const isUpdate = global.existingFiles.has(normalizedPath);
        
        // Remove any CSS imports from JSX/JS files (we're using Tailwind)
        let fileContent = file.content;
        if (file.path.endsWith('.jsx') || file.path.endsWith('.js') || file.path.endsWith('.tsx') || file.path.endsWith('.ts')) {
          fileContent = fileContent.replace(/import\s+['"]\.\/[^'"]+\.css['"];?\s*\n?/g, '');
        }
        
        // Fix common Tailwind CSS errors in CSS files
        if (file.path.endsWith('.css')) {
          // Replace shadow-3xl with shadow-2xl (shadow-3xl doesn't exist)
          fileContent = fileContent.replace(/shadow-3xl/g, 'shadow-2xl');
          // Replace any other non-existent shadow utilities
          fileContent = fileContent.replace(/shadow-4xl/g, 'shadow-2xl');
          fileContent = fileContent.replace(/shadow-5xl/g, 'shadow-2xl');
        }
        
        console.log(`[apply-ai-code] Writing file using E2B files API: ${fullPath}`);
        
        try {
          // Check if we're using provider pattern (v2) or direct sandbox (v1)
          if (sandbox.writeFile) {
            // V2: Provider pattern
            await sandbox.writeFile(file.path, fileContent);
          } else if (sandbox.files?.write) {
            // V1: Direct E2B sandbox
            await sandbox.files.write(fullPath, fileContent);
          } else {
            throw new Error('Unsupported sandbox type');
          }
          console.log(`[apply-ai-code] Successfully wrote file: ${fullPath}`);
          
          // Update file cache
          if (global.sandboxState?.fileCache) {
            global.sandboxState.fileCache.files[normalizedPath] = {
              content: fileContent,
              lastModified: Date.now()
            };
            console.log(`[apply-ai-code] Updated file cache for: ${normalizedPath}`);
          }
          
        } catch (writeError) {
          console.error(`[apply-ai-code] E2B file write error:`, writeError);
          throw writeError as Error;
        }
        
        
        if (isUpdate) {
          results.filesUpdated.push(normalizedPath);
        } else {
          results.filesCreated.push(normalizedPath);
          global.existingFiles.add(normalizedPath);
        }
      } catch (error) {
        results.errors.push(`Failed to create ${file.path}: ${(error as Error).message}`);
      }
    }
    
    // Only create App.jsx if it's not an edit and doesn't exist
    const appFileInParsed = parsed.files.some(f => {
      const normalized = f.path.replace(/^\//, '').replace(/^src\//, '');
      return normalized === 'App.jsx' || normalized === 'App.tsx';
    });
    
    const appFileExists = global.existingFiles.has('src/App.jsx') || 
                         global.existingFiles.has('src/App.tsx') ||
                         global.existingFiles.has('App.jsx') ||
                         global.existingFiles.has('App.tsx');
    
    if (!isEdit && !appFileInParsed && !appFileExists && parsed.files.length > 0) {
      // Find all component files
      const componentFiles = parsed.files.filter(f => 
        (f.path.endsWith('.jsx') || f.path.endsWith('.tsx')) &&
        f.path.includes('component')
      );
      
      // Generate imports for components
      const imports = componentFiles
        .filter(f => !f.path.includes('App.') && !f.path.includes('main.') && !f.path.includes('index.'))
        .map(f => {
          const pathParts = f.path.split('/');
          const fileName = pathParts[pathParts.length - 1];
          const componentName = fileName.replace(/\.(jsx|tsx)$/, '');
          // Fix import path - components are in src/components/
          const importPath = f.path.startsWith('src/') 
            ? f.path.replace('src/', './').replace(/\.(jsx|tsx)$/, '')
            : './' + f.path.replace(/\.(jsx|tsx)$/, '');
          return `import ${componentName} from '${importPath}';`;
        })
        .join('\n');
      
      // Find the main component
      const mainComponent = componentFiles.find(f => {
        const name = f.path.toLowerCase();
        return name.includes('header') || 
               name.includes('hero') ||
               name.includes('layout') ||
               name.includes('main') ||
               name.includes('home');
      }) || componentFiles[0];
      
      const mainComponentName = mainComponent 
        ? mainComponent.path.split('/').pop()?.replace(/\.(jsx|tsx)$/, '') 
        : null;
      
      // Create App.jsx with better structure
      const appContent = `import React from 'react';
${imports}

function App() {
  return (
    <div className="min-h-screen bg-gray-900 text-white p-8">
      ${mainComponentName ? `<${mainComponentName} />` : '<div className="text-center">\n        <h1 className="text-4xl font-bold mb-4">Welcome to your React App</h1>\n        <p className="text-gray-400">Your components have been created but need to be added here.</p>\n      </div>'}
      {/* Generated components: ${componentFiles.map(f => f.path).join(', ')} */}
    </div>
  );
}

export default App;`;
      
      try {
        // Use provider pattern if available
        if (sandbox.writeFile) {
          await sandbox.writeFile('src/App.jsx', appContent);
        } else if (sandbox.writeFiles) {
          await sandbox.writeFiles([{
            path: 'src/App.jsx',
            content: Buffer.from(appContent)
          }]);
        }
        
        console.log('Auto-generated: src/App.jsx');
        results.filesCreated.push('src/App.jsx (auto-generated)');
      } catch (error) {
        results.errors.push(`Failed to create App.jsx: ${(error as Error).message}`);
      }
      
      // Don't auto-generate App.css - we're using Tailwind CSS
      
      // Only create index.css if it doesn't exist
      const indexCssInParsed = parsed.files.some(f => {
        const normalized = f.path.replace(/^\//, '').replace(/^src\//, '');
        return normalized === 'index.css' || f.path === 'src/index.css';
      });
      
      const indexCssExists = global.existingFiles.has('src/index.css') || 
                            global.existingFiles.has('index.css');
      
      if (!isEdit && !indexCssInParsed && !indexCssExists) {
        try {
          const indexCssContent = `@tailwind base;
@tailwind components;
@tailwind utilities;

:root {
  font-family: Inter, system-ui, Avenir, Helvetica, Arial, sans-serif;
  line-height: 1.5;
  font-weight: 400;
  color-scheme: dark;
  
  color: rgba(255, 255, 255, 0.87);
  background-color: #0a0a0a;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  min-width: 320px;
  min-height: 100vh;
}`;

          // Use provider pattern if available
          if (sandbox.writeFile) {
            await sandbox.writeFile('src/index.css', indexCssContent);
          } else if (sandbox.writeFiles) {
            await sandbox.writeFiles([{
              path: 'src/index.css',
              content: Buffer.from(indexCssContent)
            }]);
          }
          
          console.log('Auto-generated: src/index.css');
          results.filesCreated.push('src/index.css (with Tailwind)');
        } catch (error) {
          console.error('Failed to create index.css:', error);
          results.errors.push('Failed to create index.css with Tailwind');
        }
      }
    }
    
    // Execute commands
    for (const cmd of parsed.commands) {
      try {
        // Parse command and arguments
        const commandParts = cmd.trim().split(/\s+/);
        const cmdName = commandParts[0];
        const args = commandParts.slice(1);
        
        // Execute command using sandbox
        let result;
        if (sandbox.runCommand && typeof sandbox.runCommand === 'function') {
          // Check if this is a provider pattern sandbox
          const testResult = await sandbox.runCommand(cmd);
          if (testResult && typeof testResult === 'object' && 'stdout' in testResult) {
            // Provider returns CommandResult directly
            result = testResult;
          } else {
            // Direct sandbox - expects object with cmd and args
            result = await sandbox.runCommand({
              cmd: cmdName,
              args
            });
          }
        }
        
        console.log(`Executed: ${cmd}`);
        
        // Handle result based on type
        let stdout = '';
        let stderr = '';
        
        if (result) {
          if (typeof result.stdout === 'string') {
            stdout = result.stdout;
            stderr = result.stderr || '';
          } else if (typeof result.stdout === 'function') {
            stdout = await result.stdout();
            stderr = await result.stderr();
          }
        }
        
        if (stdout) console.log(stdout);
        if (stderr) console.log(`Errors: ${stderr}`);
        
        results.commandsExecuted.push(cmd);
      } catch (error) {
        results.errors.push(`Failed to execute ${cmd}: ${(error as Error).message}`);
      }
    }
    
    // Check for missing imports in App.jsx
    const missingImports: string[] = [];
    const appFile = parsed.files.find(f => 
      f.path === 'src/App.jsx' || f.path === 'App.jsx'
    );
    
    if (appFile) {
      // Extract imports from App.jsx
      const importRegex = /import\s+(?:\w+|\{[^}]+\})\s+from\s+['"]([^'"]+)['"]/g;
      let match;
      const imports: string[] = [];
      
      while ((match = importRegex.exec(appFile.content)) !== null) {
        const importPath = match[1];
        if (importPath.startsWith('./') || importPath.startsWith('../')) {
          imports.push(importPath);
        }
      }
      
      // Check if all imported files exist
      for (const imp of imports) {
        // Skip CSS imports for this check
        if (imp.endsWith('.css')) continue;
        
        // Convert import path to expected file paths
        const basePath = imp.replace('./', 'src/');
        const possiblePaths = [
          basePath + '.jsx',
          basePath + '.js',
          basePath + '/index.jsx',
          basePath + '/index.js'
        ];
        
        const fileExists = parsed.files.some(f => 
          possiblePaths.some(path => f.path === path)
        );
        
        if (!fileExists) {
          missingImports.push(imp);
        }
      }
    }
    
    // Unused by the UI (generation uses apply-ai-code-stream). Keep the
    // closing sentence on applyOutcome so a reader of this live route is
    // not handed a second, stale success line.
    const outcome = applyOutcome({
      filesCreated: results.filesCreated,
      filesUpdated: results.filesUpdated,
      errors: results.errors,
    });
    const responseData: any = {
      success: true,
      results,
      explanation: parsed.explanation,
      structure: parsed.structure,
      message: outcome.message,
    };
    if (outcome.warning) {
      responseData.warning = outcome.warning;
    }
    
    // Missing imports are reported, not generated. The block here used to POST
    // to a component-completion route that has never existed in this
    // repository: every call 404'd, the .json() parse threw, and the catch
    // produced exactly this warning. Only the warning is left.
    if (missingImports.length > 0) {
      console.warn('[apply-ai-code] Missing imports detected:', missingImports);
      responseData.warning = `Missing ${missingImports.length} imported components: ${missingImports.join(', ')}`;
      responseData.missingImports = missingImports;
    }
    
    // Track applied files in conversation state
    if (global.conversationState && results.filesCreated.length > 0) {
      // Update the last message metadata with edited files
      const messages = global.conversationState.context.messages;
      if (messages.length > 0) {
        const lastMessage = messages[messages.length - 1];
        if (lastMessage.role === 'user') {
          lastMessage.metadata = {
            ...lastMessage.metadata,
            editedFiles: results.filesCreated
          };
        }
      }
      
      // Track applied code in project evolution
      if (global.conversationState.context.projectEvolution) {
        global.conversationState.context.projectEvolution.majorChanges.push({
          timestamp: Date.now(),
          description: parsed.explanation || 'Code applied',
          filesAffected: results.filesCreated
        });
      }
      
      // Update last updated timestamp
      global.conversationState.lastUpdated = Date.now();
      
      console.log('[apply-ai-code] Updated conversation state with applied files:', results.filesCreated);
    }
    
    return NextResponse.json(responseData);
    
  } catch (error) {
    console.error('Apply AI code error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to parse AI code' },
      { status: 500 }
    );
  }
}