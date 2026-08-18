// Using direct fetch to Morph's OpenAI-compatible API to avoid SDK type issues
import { getSetting } from '@/lib/settings/resolve';
import { isStackConfigFile, shouldForceSrcPrefix } from '@/lib/stacks';

export interface MorphEditBlock {
  targetFile: string;
  instructions: string;
  update: string;
}

export interface MorphApplyResult {
  success: boolean;
  normalizedPath?: string;
  mergedCode?: string;
  error?: string;
}

/**
 * Normalize project-relative paths to sandbox layout.
 *
 * `stack` is required on purpose. Only REACT keeps sources under `src/`; forcing that
 * prefix on NEXTJS (the default stack) rewrote `app/page.tsx` to `src/app/page.tsx`,
 * so the read missed and Morph edits landed in a stray file. Defer to the stack
 * registry rather than a hardcoded React config list.
 */
export function normalizeProjectPath(
  inputPath: string,
  stack: string,
): { normalizedPath: string; fullPath: string } {
  let normalizedPath = inputPath.trim();
  if (normalizedPath.startsWith('/')) normalizedPath = normalizedPath.slice(1);

  if (
    shouldForceSrcPrefix(stack) &&
    !normalizedPath.startsWith('src/') &&
    !normalizedPath.startsWith('public/') &&
    normalizedPath !== 'index.html' &&
    !isStackConfigFile(stack, normalizedPath)
  ) {
    normalizedPath = 'src/' + normalizedPath;
  }

  const fullPath = `/home/user/app/${normalizedPath}`;
  return { normalizedPath, fullPath };
}

/**
 * Single source of truth for "is Morph usable". The routes used to gate on
 * process.env.MORPH_API_KEY while the API call read the admin setting, so a key
 * entered in /admin/config left the feature switched off and never ran.
 */
export async function isMorphConfigured(): Promise<boolean> {
  return Boolean(await getSetting('tooling.morph.apiKey'));
}

async function morphChatCompletionsCreate(payload: any) {
  const morphKey = await getSetting('tooling.morph.apiKey');
  if (!morphKey) {
    throw new Error('No Morph API key is configured. Add one in Admin -> Configuration.');
  }
  const res = await fetch('https://api.morphllm.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${morphKey}`
    },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Morph API error ${res.status}: ${text}`);
  }
  return res.json();
}

// Parse <edit> blocks from LLM output
export function parseMorphEdits(text: string): MorphEditBlock[] {
  const edits: MorphEditBlock[] = [];
  const editRegex = /<edit\s+target_file="([^"]+)">([\s\S]*?)<\/edit>/g;
  let match: RegExpExecArray | null;
  while ((match = editRegex.exec(text)) !== null) {
    const targetFile = match[1].trim();
    const inner = match[2];
    const instrMatch = inner.match(/<instructions>([\s\S]*?)<\/instructions>/);
    const updateMatch = inner.match(/<update>([\s\S]*?)<\/update>/);
    const instructions = instrMatch ? instrMatch[1].trim() : '';
    const update = updateMatch ? updateMatch[1].trim() : '';
    if (targetFile && update) {
      edits.push({ targetFile, instructions, update });
    }
  }
  return edits;
}

/** stdout only when the command itself succeeded. Empty stdout + exit 1 is "not found", not an empty file. */
function successfulCommandStdout(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null;
  const command = result as { stdout?: unknown; success?: unknown; exitCode?: unknown };
  if (typeof command.stdout !== 'string') return null;
  if (command.success === false) return null;
  if (typeof command.exitCode === 'number' && command.exitCode !== 0) return null;
  return command.stdout;
}

function commandFailed(result: unknown): boolean {
  if (!result || typeof result !== 'object') return false;
  const command = result as { success?: unknown; exitCode?: unknown };
  if (command.success === false) return true;
  return typeof command.exitCode === 'number' && command.exitCode !== 0;
}

// Read a file from sandbox: prefers cache, then sandbox.files, then commands.run("cat ...")
async function readFileFromSandbox(sandbox: any, normalizedPath: string, fullPath: string): Promise<string> {
  // Try backend cache first
  if ((global as any).sandboxState?.fileCache?.files?.[normalizedPath]?.content) {
    return (global as any).sandboxState.fileCache.files[normalizedPath].content as string;
  }

  // Try E2B files API
  if (sandbox?.files?.read) {
    return await sandbox.files.read(fullPath);
  }

  // Try provider runCommand (preferred for provider pattern)
  if (typeof sandbox?.runCommand === 'function') {
    try {
      const relative = successfulCommandStdout(await sandbox.runCommand(`cat ${normalizedPath}`));
      if (relative !== null) return relative;
    } catch {
      // Relative cat is a probe: cwd may not be the app root. Try the absolute path next.
    }
    try {
      const absolute = successfulCommandStdout(await sandbox.runCommand(`cat ${fullPath}`));
      if (absolute !== null) return absolute;
    } catch (error) {
      if (!sandbox?.commands?.run) throw error;
      // Absolute cat is still a probe; E2B commands.run is the last reader.
    }
  }

  // Try shell cat via commands.run
  if (sandbox?.commands?.run) {
    const result = await sandbox.commands.run(`cat ${fullPath}`, { cwd: '/home/user/app', timeout: 30 });
    if (result?.exitCode === 0 && typeof result?.stdout === 'string') {
      return result.stdout as string;
    }
  }

  throw new Error(`Unable to read file: ${normalizedPath}`);
}

// Write a file to sandbox and update cache
async function writeFileToSandbox(sandbox: any, normalizedPath: string, fullPath: string, content: string): Promise<void> {
  // Provider pattern (writeFile)
  if (typeof sandbox?.writeFile === 'function') {
    await sandbox.writeFile(normalizedPath, content);
    return;
  }

  // Provider pattern (runCommand redirect)
  if (typeof sandbox?.runCommand === 'function') {
    // Ensure directory exists. A failed mkdir is not a fallback — the write cannot proceed.
    const dir = normalizedPath.includes('/') ? normalizedPath.substring(0, normalizedPath.lastIndexOf('/')) : '';
    if (dir) {
      const mkdir = await sandbox.runCommand(`mkdir -p ${dir}`);
      if (commandFailed(mkdir)) {
        throw new Error(`Failed to create directory ${dir} for ${normalizedPath}`);
      }
    }
    const heredoc = `bash -lc 'cat > ${normalizedPath} <<\"EOF\"\n${content.replace(/\\/g, '\\\\').replace(/\n/g, '\n').replace(/\$/g, '\$')}\nEOF'`;
    const written = await sandbox.runCommand(heredoc);
    if (commandFailed(written)) {
      throw new Error(`Failed to write file via shell: ${normalizedPath}`);
    }
    return;
  }

  // Prefer E2B files API
  if (sandbox?.files?.write) {
    await sandbox.files.write(fullPath, content);
  } else if (sandbox?.runCode) {
    // Use Python to write safely
    const escaped = content
      .replace(/\\/g, '\\\\')
      .replace(/"""/g, '\"\"\"');
    await sandbox.runCode(`
import os
os.makedirs(os.path.dirname("${fullPath}"), exist_ok=True)
with open("${fullPath}", 'w') as f:
    f.write("""${escaped}""")
print("WROTE:${fullPath}")
    `);
  } else if (sandbox?.commands?.run) {
    // Shell redirection (fallback)
    // Note: beware of special chars; this is a last-resort path
    const result = await sandbox.commands.run(`bash -lc 'mkdir -p "$(dirname "${fullPath}")" && cat > "${fullPath}" << \EOF\n${content}\nEOF'`, { cwd: '/home/user/app', timeout: 60 });
    if (result?.exitCode !== 0) {
      throw new Error(`Failed to write file via shell: ${normalizedPath}`);
    }
  } else {
    throw new Error('No available method to write files to sandbox');
  }

  // Update backend cache if available
  if ((global as any).sandboxState?.fileCache) {
    (global as any).sandboxState.fileCache.files[normalizedPath] = {
      content,
      lastModified: Date.now()
    };
  }
  if ((global as any).existingFiles) {
    (global as any).existingFiles.add(normalizedPath);
  }
}

export async function applyMorphEditToFile(params: {
  sandbox: any;
  targetPath: string;
  instructions: string;
  updateSnippet: string;
  stack: string;
}): Promise<MorphApplyResult> {
  try {
    if (!(await isMorphConfigured())) {
      return { success: false, error: 'No Morph API key is configured' };
    }

    const { normalizedPath, fullPath } = normalizeProjectPath(params.targetPath, params.stack);

    // Read original code (existence validation happens here)
    const initialCode = await readFileFromSandbox(params.sandbox, normalizedPath, fullPath);

    const resp = await morphChatCompletionsCreate({
      model: 'morph-v3-large',
      messages: [
        {
          role: 'user',
          content: `<instruction>${params.instructions || ''}</instruction>\n<code>${initialCode}</code>\n<update>${params.updateSnippet}</update>`
        }
      ]
    });

    const mergedCode = (resp as any)?.choices?.[0]?.message?.content || '';
    if (!mergedCode) {
      return { success: false, error: 'Morph returned empty content', normalizedPath };
    }

    await writeFileToSandbox(params.sandbox, normalizedPath, fullPath, mergedCode);

    return { success: true, normalizedPath, mergedCode };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
}


