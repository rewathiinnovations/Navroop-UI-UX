import { NextRequest, NextResponse } from 'next/server';
import { parseMorphEdits, applyMorphEditToFile } from '@/lib/morph-fast-apply';
// Sandbox import not needed - using global sandbox from sandbox-manager
import type { SandboxState } from '@/types/sandbox';
import type { ConversationState } from '@/types/conversation';
import { sandboxManager } from '@/lib/sandbox/sandbox-manager';
import { ensureSandbox, getLiveProvider, SandboxBootError } from '@/lib/sandbox/manager';
import { resolveRequestStack } from '@/lib/stack-resolve';
import {
  getStack,
  isStackConfigFile,
  packageNameFromImport,
  shouldForceSrcPrefix,
  shouldSkipPackageInstall,
} from '@/lib/stacks';
import { fulfillNeedImages } from '@/lib/assets/fulfill';
import { getSessionUser, requireSessionUser } from '@/lib/auth';
import { jsonError } from '@/lib/api/error-response';
import { installPackages } from '@/lib/sandbox/install-packages';
import { acquireLock, beginLockHeartbeat, releaseLock } from '@/lib/projects/lock';
import { lockConflictJson } from '@/lib/projects/lock-http';
import { beginJobHeartbeat, createOrReuseJob, failJob, markJobRunning, succeedJob } from '@/lib/jobs/lifecycle';
import { ensureJobSettled } from '@/lib/jobs/settle';
import { applyOutcome } from '@/lib/jobs/copy';
import { assertWritableGenerationFile } from '@/lib/generation/write-guard';
import { recordJobStepFailure } from '@/lib/jobs/step-failure';
import { log } from '@/lib/logger';
import { WORKSPACE_ROW_ID } from '@/lib/storage/usage';
import { getRequestId } from '@/lib/request-context';

declare global {
  var conversationState: ConversationState | null;
  var activeSandboxProvider: any;
  var existingFiles: Set<string>;
  var sandboxState: SandboxState;
}

/**
 * Reports a terminal job write that failed, instead of discarding it.
 *
 * The chat's busy state follows the job row, so a lost settle is an apply that hangs: the
 * input stays locked and the building indicator keeps spinning until the 20-minute hard
 * timeout. `.catch(() => undefined)` kept the `finally` from throwing and threw the
 * diagnosis away with it.
 *
 * Never throws, so a settle failure cannot replace the error the caller is already
 * unwinding with, and cannot skip the rest of the cleanup.
 */
async function reportSettleFailure(input: {
  jobId: string;
  intended: 'succeeded' | 'failed';
  error: unknown;
}): Promise<void> {
  const detail = input.error instanceof Error ? input.error.message : String(input.error);
  const summary = `Could not record the final job status (${input.intended}): ${detail}`;
  try {
    log.error('apply.settle_write_failed', {
      jobId: input.jobId,
      intended: input.intended,
      error: detail,
    });
    // Puts it in front of a human: the workspace recovery panel and /admin/jobs both read
    // job steps. Never throws.
    await recordJobStepFailure(input.jobId, {
      key: 'settle-job',
      label: 'Record the final job status',
      error: summary,
    });
    // A much simpler write than succeedJob's raw-SQL phase update, so it can still land
    // when that one could not — and it reports its own verdict either way.
    const outcome = await ensureJobSettled(input.jobId, {
      errorCode: 'settle_write_failed',
      errorMessage: summary,
    });
    log.warn('apply.settle_write_fallback', { jobId: input.jobId, outcome });
  } catch (reportError) {
    console.error('[apply-ai-code-stream] Failed to report a lost settle:', summary, reportError);
  }
}

/**
 * Settles the job on a path that answers with an error the user will read.
 *
 * Every early `return` in this handler is a response the user sees immediately. Leaving the
 * job RUNNING behind one of them means the chat input stays locked and still says
 * "Building — hang tight" on top of a 409 the user has already read, until the reaper
 * notices the stopped heartbeat about a minute later. Settling here removes that minute.
 *
 * Never throws: a bookkeeping failure must not replace the answer we are about to send.
 */
async function failApplyJob(
  jobId: string | null,
  errorCode: string,
  errorMessage: string,
): Promise<void> {
  if (!jobId) return;
  try {
    await failJob(jobId, { errorCode, errorMessage });
  } catch (settleError) {
    await reportSettleFailure({ jobId, intended: 'failed', error: settleError });
  }
}

interface ParsedResponse {
  explanation: string;
  template: string;
  files: Array<{ path: string; content: string }>;
  packages: string[];
  commands: string[];
  structure: string | null;
}

function parseAIResponse(response: string, stack: string): ParsedResponse {
  const sections = {
    files: [] as Array<{ path: string; content: string }>,
    commands: [] as string[],
    packages: [] as string[],
    structure: null as string | null,
    explanation: '',
    template: ''
  };

  // Function to extract packages from import statements
  function extractPackagesFromCode(content: string): string[] {
    const packages: string[] = [];
    // Match ES6 imports
    const importRegex = /import\s+(?:(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)(?:\s*,\s*(?:\{[^}]*\}|\*\s+as\s+\w+|\w+))*\s+from\s+)?['"]([^'"]+)['"]/g;
    let importMatch;

    while ((importMatch = importRegex.exec(content)) !== null) {
      const importPath = importMatch[1];
      if (!shouldSkipPackageInstall(stack, importPath)) {
        const packageName = packageNameFromImport(importPath);

        if (!packages.includes(packageName)) {
          packages.push(packageName);

          // Log important packages for debugging
          if (packageName === 'react-router-dom' || packageName.includes('router') || packageName.includes('icon')) {
            console.log(`[apply-ai-code-stream] Detected package from imports: ${packageName}`);
          }
        }
      }
    }

    return packages;
  }

  // Parse file sections - handle duplicates and prefer complete versions
  const fileMap = new Map<string, { content: string; isComplete: boolean }>();

  // First pass: Find all file declarations
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
      console.log(`[apply-ai-code-stream] Replacing incomplete ${filePath} with complete version`);
    } else if (existing.isComplete && hasClosingTag && content.length > existing.content.length) {
      shouldReplace = true; // Replace with longer complete version
      console.log(`[apply-ai-code-stream] Replacing ${filePath} with longer complete version`);
    } else if (!existing.isComplete && !hasClosingTag && content.length > existing.content.length) {
      shouldReplace = true; // Both incomplete, keep longer one
    }

    if (shouldReplace) {
      // Additional validation: reject obviously broken content
      if (content.includes('...') && !content.includes('...props') && !content.includes('...rest')) {
        console.warn(`[apply-ai-code-stream] Warning: ${filePath} contains ellipsis, may be truncated`);
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
      console.log(`[apply-ai-code-stream] Warning: File ${path} appears to be truncated (no closing tag)`);
    }

    sections.files.push({
      path,
      content
    });

    // Extract packages from file content
    const filePackages = extractPackagesFromCode(content);
    for (const pkg of filePackages) {
      if (!sections.packages.includes(pkg)) {
        sections.packages.push(pkg);
        console.log(`[apply-ai-code-stream] 📦 Package detected from imports: ${pkg}`);
      }
    }
  }

  // Also parse markdown code blocks with file paths
  const markdownFileRegex = /```(?:file )?path="([^"]+)"\n([\s\S]*?)```/g;
  while ((match = markdownFileRegex.exec(response)) !== null) {
    const filePath = match[1];
    const content = match[2].trim();
    sections.files.push({
      path: filePath,
      content: content
    });

    // Extract packages from file content
    const filePackages = extractPackagesFromCode(content);
    for (const pkg of filePackages) {
      if (!sections.packages.includes(pkg)) {
        sections.packages.push(pkg);
        console.log(`[apply-ai-code-stream] 📦 Package detected from imports: ${pkg}`);
      }
    }
  }

  // Parse plain text format like "Generated Files: Header.jsx, index.css"
  const generatedFilesMatch = response.match(/Generated Files?:\s*([^\n]+)/i);
  if (generatedFilesMatch) {
    // Split by comma first, then trim whitespace, to preserve filenames with dots
    const filesList = generatedFilesMatch[1]
      .split(',')
      .map(f => f.trim())
      .filter(f => f.endsWith('.jsx') || f.endsWith('.js') || f.endsWith('.tsx') || f.endsWith('.ts') || f.endsWith('.css') || f.endsWith('.json') || f.endsWith('.html'));
    console.log(`[apply-ai-code-stream] Detected generated files from plain text: ${filesList.join(', ')}`);

    // Try to extract the actual file content if it follows
    for (const fileName of filesList) {
      // Look for the file content after the file name
      const fileContentRegex = new RegExp(`${fileName}[\\s\\S]*?(?:import[\\s\\S]+?)(?=Generated Files:|Applying code|$)`, 'i');
      const fileContentMatch = response.match(fileContentRegex);
      if (fileContentMatch) {
        // Extract just the code part (starting from import statements)
        const codeMatch = fileContentMatch[0].match(/^(import[\s\S]+)$/m);
        if (codeMatch) {
          const filePath = fileName.includes('/') ? fileName : `src/components/${fileName}`;
          sections.files.push({
            path: filePath,
            content: codeMatch[1].trim()
          });
          console.log(`[apply-ai-code-stream] Extracted content for ${filePath}`);

          // Extract packages from this file
          const filePackages = extractPackagesFromCode(codeMatch[1]);
          for (const pkg of filePackages) {
            if (!sections.packages.includes(pkg)) {
              sections.packages.push(pkg);
              console.log(`[apply-ai-code-stream] Package detected from imports: ${pkg}`);
            }
          }
        }
      }
    }
  }

  // Also try to parse if the response contains raw JSX/JS code blocks
  const codeBlockRegex = /```(?:jsx?|tsx?|javascript|typescript)?\n([\s\S]*?)```/g;
  while ((match = codeBlockRegex.exec(response)) !== null) {
    const content = match[1].trim();
    // Try to detect the file name from comments or context
    const fileNameMatch = content.match(/\/\/\s*(?:File:|Component:)\s*([^\n]+)/);
    if (fileNameMatch) {
      const fileName = fileNameMatch[1].trim();
      const filePath = fileName.includes('/') ? fileName : `src/components/${fileName}`;

      // Don't add duplicate files
      if (!sections.files.some(f => f.path === filePath)) {
        sections.files.push({
          path: filePath,
          content: content
        });

        // Extract packages
        const filePackages = extractPackagesFromCode(content);
        for (const pkg of filePackages) {
          if (!sections.packages.includes(pkg)) {
            sections.packages.push(pkg);
          }
        }
      }
    }
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

export async function POST(request: NextRequest) {
  // Writes files into the active sandbox, so a session is required even when
  // the caller sends no projectId (the lock/job branch below is project-scoped).
  const auth = await requireSessionUser();
  if (!auth.user) return jsonError(auth.error, 'UNAUTHORIZED', auth.status);

  let releaseApplyLock: (() => Promise<void>) | null = null;
  let applyJobId: string | null = null;
  let applyJobHeartbeat: { stop: () => void } | null = null;
  let applyFailed = false;
  try {
    const {
      response,
      isEdit = false,
      packages = [],
      sandboxId: requestSandboxId,
      projectId,
      stack: requestStack,
    } = await request.json();
    let sandboxId = requestSandboxId;

    const lockProjectId = typeof projectId === 'string' ? projectId.trim() : '';
    if (lockProjectId) {
      const sessionUser = await getSessionUser();
      if (!sessionUser) {
        return NextResponse.json({ error: 'Sign in required' }, { status: 401 });
      }
      const lock = await acquireLock(lockProjectId, sessionUser.id, 'generation');
      if (!lock.ok) return lockConflictJson(lock);
      const heartbeat = beginLockHeartbeat(lockProjectId, sessionUser.id);
      const applyJob = await createOrReuseJob({
        projectId: lockProjectId,
        workspaceId: WORKSPACE_ROW_ID,
        userId: sessionUser.id,
        kind: 'FOLLOWUP',
        inputPrompt: typeof response === 'string' ? response.slice(0, 2000) : null,
        requestId: getRequestId(),
      });
      if (applyJob.status === 'QUEUED') {
        await markJobRunning(applyJob.id, { chargeCredits: true, acquireProjectLock: false });
      }
      applyJobId = applyJob.id;
      // Tied to the request: a live heartbeat hides the row from the staleness reaper, so a
      // client that disconnects must stop vouching for work nobody is reading.
      applyJobHeartbeat = beginJobHeartbeat(applyJob.id, { signal: request.signal });
      releaseApplyLock = async () => {
        heartbeat.stop();
        applyJobHeartbeat?.stop();
        await releaseLock(lockProjectId, sessionUser.id);
        releaseApplyLock = null;
      };
    }

    if (!response) {
      await failApplyJob(applyJobId, 'provider_error', 'The request did not include any AI response to apply.');
      await releaseApplyLock?.();
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
    const stackDef = getStack(activeStack);

    // Debug log the response
    console.log('[apply-ai-code-stream] Received response to parse:');
    console.log('[apply-ai-code-stream] Response length:', response.length);
    console.log('[apply-ai-code-stream] Response preview:', response.substring(0, 500));
    console.log('[apply-ai-code-stream] isEdit:', isEdit);
    console.log('[apply-ai-code-stream] packages:', packages);
    console.log('[apply-ai-code-stream] stack:', stackDef.id);

    // Parse the AI response
    const parsed = parseAIResponse(response, stackDef.id);
    const morphEnabled = Boolean(isEdit && process.env.MORPH_API_KEY);
    const morphEdits = morphEnabled ? parseMorphEdits(response) : [];
    console.log('[apply-ai-code-stream] Morph Fast Apply mode:', morphEnabled);
    if (morphEnabled) {
      console.log('[apply-ai-code-stream] Morph edits found:', morphEdits.length);
    }
    
    // Log what was parsed
    console.log('[apply-ai-code-stream] Parsed result:');
    console.log('[apply-ai-code-stream] Files found:', parsed.files.length);
    if (parsed.files.length > 0) {
      parsed.files.forEach(f => {
        console.log(`[apply-ai-code-stream] - ${f.path} (${f.content.length} chars)`);
      });
    }
    console.log('[apply-ai-code-stream] Packages found:', parsed.packages);

    // Initialize existingFiles if not already
    if (!global.existingFiles) {
      global.existingFiles = new Set<string>();
    }

    let provider = sandboxId ? sandboxManager.getProvider(sandboxId) : sandboxManager.getActiveProvider();
    if (!provider) {
      provider = global.activeSandboxProvider;
    }

    if (typeof projectId === 'string' && projectId.trim()) {
      try {
        const ensured = await ensureSandbox(projectId.trim(), { allowEmpty: true });
        provider = getLiveProvider(ensured.sandboxId) || provider;
        sandboxId = ensured.sandboxId;
        global.sandboxData = {
          sandboxId: ensured.sandboxId,
          url: ensured.previewUrl,
          stack: stackDef.id,
        };
      } catch (providerError) {
        const boot = providerError instanceof SandboxBootError ? providerError : null;
        console.error(`[apply-ai-code-stream] ensureSandbox failed:`, providerError);
        await failApplyJob(
          applyJobId,
          'sandbox_unavailable',
          boot?.code === 'NO_CHECKPOINT'
            ? 'This project has no saved snapshot to start a workspace from, so the changes could not be applied.'
            : `The workspace for this project could not be started, so the changes could not be applied. ${
                providerError instanceof Error ? providerError.message : 'Failed to start sandbox'
              }`,
        );
        await releaseApplyLock?.();
        return NextResponse.json({
          success: false,
          error: providerError instanceof Error ? providerError.message : 'Failed to start sandbox',
          step: boot?.step,
          code: boot?.code,
          requestId: boot?.requestId,
          results: {
            filesCreated: [],
            packagesInstalled: [],
            commandsExecuted: [],
            errors: [providerError instanceof Error ? providerError.message : 'ensureSandbox failed'],
          },
          explanation: parsed.explanation,
          structure: parsed.structure,
          parsedFiles: parsed.files,
          message: `Parsed ${parsed.files.length} files but couldn't apply them — sandbox is not ready.`,
        }, { status: boot?.code === 'NO_CHECKPOINT' ? 409 : 500 });
      }
    }

    if (!provider) {
      await failApplyJob(
        applyJobId,
        'sandbox_unavailable',
        'No workspace is running for this project, so the changes could not be applied. Open the project so it can start from its latest snapshot, then try again.',
      );
      await releaseApplyLock?.();
      return NextResponse.json({
        success: false,
        error: 'No active sandbox. Open the project so it can cold-start from the latest checkpoint.',
        results: {
          filesCreated: [],
          packagesInstalled: [],
          commandsExecuted: [],
          errors: ['No sandbox provider'],
        },
        explanation: parsed.explanation,
        structure: parsed.structure,
        parsedFiles: parsed.files,
        message: `Parsed ${parsed.files.length} files but couldn't apply them — no sandbox.`,
      }, { status: 409 });
    }

    // Create a response stream for real-time updates
    const encoder = new TextEncoder();
    const stream = new TransformStream();
    const writer = stream.writable.getWriter();

    // A TransformStream writable has highWaterMark 1, so a reader that stops consuming but
    // is not yet torn down parks `writer.write` forever — and a parked producer never reaches
    // its `finally`, which is what leaves the job RUNNING until the 20-minute timeout.
    // Racing each write against the request's abort is what lets it unwind.
    let clientDisconnected = false;
    let clientDisconnectReason: string | null = null;
    const noteClientDisconnected = (reason: string) => {
      if (clientDisconnected) return;
      clientDisconnected = true;
      clientDisconnectReason = reason;
      log.warn('apply.client_disconnected', { jobId: applyJobId, reason });
    };
    if (request.signal.aborted) {
      noteClientDisconnected('request was already aborted when streaming started');
    }
    request.signal.addEventListener('abort', () => noteClientDisconnected('request aborted'), {
      once: true,
    });
    const clientGone = new Promise<void>((resolve) => {
      if (request.signal.aborted) {
        resolve();
        return;
      }
      request.signal.addEventListener('abort', () => resolve(), { once: true });
    });

    // Function to send progress updates
    const sendProgress = async (data: Record<string, unknown>) => {
      if (clientDisconnected) return;
      // The catch is attached before the race, so the write we walk away from cannot surface
      // later as an unhandled rejection. Non-throwing on purpose: this used to throw out of
      // the error handler below, which then skipped `applyFailed` and marked a failed apply
      // SUCCEEDED. Unlike generation, the work itself still runs to completion — a
      // half-written sandbox is worse than an unwatched one.
      const written = writer
        .write(encoder.encode(`data: ${JSON.stringify(data)}\n\n`))
        .catch((error: unknown) =>
          noteClientDisconnected(error instanceof Error ? error.message : String(error)),
        );
      await Promise.race([written, clientGone]);
    };

    // Start processing in background (pass provider and request to the async function)
    (async (providerInstance, req) => {
      const results = {
        filesCreated: [] as string[],
        filesUpdated: [] as string[],
        packagesInstalled: [] as string[],
        packagesAlreadyInstalled: [] as string[],
        packagesFailed: [] as string[],
        commandsExecuted: [] as string[],
        errors: [] as string[]
      };

      try {
        await sendProgress({
          type: 'start',
          message: 'Starting code application...',
          totalSteps: 3
        });
        if (morphEnabled) {
          await sendProgress({ type: 'info', message: 'Morph Fast Apply enabled' });
          await sendProgress({ type: 'info', message: `Parsed ${morphEdits.length} Morph edits` });
          if (morphEdits.length === 0) {
            console.warn('[apply-ai-code-stream] Morph enabled but no <edit> blocks found; falling back to full-file flow');
            await sendProgress({ type: 'warning', message: 'Morph enabled but no <edit> blocks found; falling back to full-file flow' });
          }
        }
        
        // Step 1: Install packages
        const packagesArray = Array.isArray(packages) ? packages : [];
        const parsedPackages = Array.isArray(parsed.packages) ? parsed.packages : [];

        // Combine and deduplicate packages
        const allPackages = [...packagesArray.filter(pkg => pkg && typeof pkg === 'string'), ...parsedPackages];

        // Use Set to remove duplicates, then filter out pre-installed packages
        const uniquePackages = [...new Set(allPackages)]
          .filter(pkg => pkg && typeof pkg === 'string' && pkg.trim() !== '') // Remove empty strings
          .filter(pkg => !shouldSkipPackageInstall(stackDef.id, pkg));

        // Log if we found duplicates
        if (allPackages.length !== uniquePackages.length) {
          console.log(`[apply-ai-code-stream] Removed ${allPackages.length - uniquePackages.length} duplicate packages`);
          console.log(`[apply-ai-code-stream] Original packages:`, allPackages);
          console.log(`[apply-ai-code-stream] Deduplicated packages:`, uniquePackages);
        }

        if (uniquePackages.length > 0) {
          await sendProgress({
            type: 'step',
            step: 1,
            message: `Installing ${uniquePackages.length} packages...`,
            packages: uniquePackages
          });

          // Install packages, forwarding each progress event into this stream.
          try {
            const installResult = await installPackages({
              packages: uniquePackages,
              onProgress: async (event) => {
                // Forwarded verbatim. The previous `{ type: 'package-progress',
                // ...data }` spread let the install event's own `type` win, and
                // the client switches on those inner types.
                await sendProgress({ ...event });
                if (event.type === 'success' && event.installedPackages) {
                  results.packagesInstalled = event.installedPackages;
                }
              },
            });

            if (!installResult.ok) {
              // Log and continue, which is what this route already did. The
              // files are worth writing even without their dependencies: the
              // user sees a resolve error in the preview and can retry the
              // install, whereas aborting discards the whole generation.
              console.error('[apply-ai-code-stream] Package installation failed:', installResult.error);
              await sendProgress({
                type: 'warning',
                message: `Package installation failed (${installResult.error}). Continuing with file creation...`,
              });
              results.errors.push(`Package installation failed: ${installResult.error}`);
              await recordJobStepFailure(applyJobId, {
                key: 'install-packages',
                label: 'Install packages',
                error: installResult.error,
              });
            } else if (!installResult.previewReady && installResult.previewNotice) {
              // Packages and files are still kept. A dead preview is not a
              // failed apply — record it so recovery /admin/jobs can see it.
              results.errors.push(installResult.previewNotice);
              await recordJobStepFailure(applyJobId, {
                key: 'restart-dev',
                label: 'Restart the preview',
                error: installResult.previewNotice,
              });
            }
          } catch (error) {
            console.error('[apply-ai-code-stream] Error installing packages:', error);
            await sendProgress({
              type: 'warning',
              message: `Package installation skipped (${(error as Error).message}). Continuing with file creation...`
            });
            results.errors.push(`Package installation failed: ${(error as Error).message}`);
            await recordJobStepFailure(applyJobId, {
              key: 'install-packages',
              label: 'Install packages',
              error: (error as Error).message,
            });
          }
        } else {
          await sendProgress({
            type: 'step',
            step: 1,
            message: 'No additional packages to install, skipping...'
          });
        }

        // Step 2: Create/update files
        const filesArray = Array.isArray(parsed.files) ? parsed.files : [];
        await sendProgress({
          type: 'step',
          step: 2,
          message: `Creating ${filesArray.length} files...`
        });

        // Filter out config files that shouldn't be created (per-stack registry).
        let filteredFiles = filesArray.filter(file => {
          if (!file || typeof file !== 'object') return false;
          return !isStackConfigFile(stackDef.id, file.path || '');
        });

        if (projectId && filteredFiles.some((file) => file.content?.includes('NEED_IMAGE:'))) {
          try {
            const sessionUser = await getSessionUser();
            await sendProgress({ type: 'status', message: 'Resolving requested images…' });
            filteredFiles = await fulfillNeedImages({
              projectId,
              userId: sessionUser?.id,
              files: filteredFiles,
            });
          } catch (error) {
            console.warn('[apply-ai-code-stream] NEED_IMAGE fulfill failed', error);
            await sendProgress({
              type: 'warning',
              message: `Image generation failed: ${(error as Error).message}`,
            });
          }
        }

        // If Morph is enabled and we have edits, apply them before file writes
        const morphUpdatedPaths = new Set<string>();
        if (morphEnabled && morphEdits.length > 0) {
          const morphSandbox = (global as any).activeSandbox || providerInstance;
          if (!morphSandbox) {
            console.warn('[apply-ai-code-stream] No sandbox available to apply Morph edits');
            await sendProgress({ type: 'warning', message: 'No sandbox available to apply Morph edits' });
          } else {
            await sendProgress({ type: 'info', message: `Applying ${morphEdits.length} fast edits via Morph...` });
            for (const [idx, edit] of morphEdits.entries()) {
              try {
                await sendProgress({ type: 'file-progress', current: idx + 1, total: morphEdits.length, fileName: edit.targetFile, action: 'morph-applying' });
                const result = await applyMorphEditToFile({
                  sandbox: morphSandbox,
                  targetPath: edit.targetFile,
                  instructions: edit.instructions,
                  updateSnippet: edit.update
                });
                if (result.success && result.normalizedPath) {
                  console.log('[apply-ai-code-stream] Morph updated', result.normalizedPath);
                  morphUpdatedPaths.add(result.normalizedPath);
                  if (results.filesUpdated) results.filesUpdated.push(result.normalizedPath);
                  await sendProgress({ type: 'file-complete', fileName: result.normalizedPath, action: 'morph-updated' });
                } else {
                  const msg = result.error || 'Unknown Morph error';
                  console.error('[apply-ai-code-stream] Morph apply failed for', edit.targetFile, msg);
                  if (results.errors) results.errors.push(`Morph apply failed for ${edit.targetFile}: ${msg}`);
                  await recordJobStepFailure(applyJobId, {
                    key: `write-file:${edit.targetFile}`,
                    label: `Write ${edit.targetFile}`,
                    error: msg,
                  });
                  await sendProgress({ type: 'file-error', fileName: edit.targetFile, error: msg });
                }
              } catch (err) {
                const msg = (err as Error).message;
                console.error('[apply-ai-code-stream] Morph apply exception for', edit.targetFile, msg);
                if (results.errors) results.errors.push(`Morph apply exception for ${edit.targetFile}: ${msg}`);
                await recordJobStepFailure(applyJobId, {
                  key: `write-file:${edit.targetFile}`,
                  label: `Write ${edit.targetFile}`,
                  error: msg,
                });
                await sendProgress({ type: 'file-error', fileName: edit.targetFile, error: msg });
              }
            }
          }
        }

        // Avoid overwriting Morph-updated files in the file write loop
        if (morphUpdatedPaths.size > 0) {
          filteredFiles = filteredFiles.filter(file => {
            if (!file?.path) return true;
            let normalizedPath = file.path.startsWith('/') ? file.path.slice(1) : file.path;
            const fileName = normalizedPath.split('/').pop() || '';
            if (shouldForceSrcPrefix(stackDef.id) &&
                !normalizedPath.startsWith('src/') &&
                !normalizedPath.startsWith('public/') &&
                normalizedPath !== 'index.html' &&
                !isStackConfigFile(stackDef.id, fileName)) {
              normalizedPath = 'src/' + normalizedPath;
            }
            return !morphUpdatedPaths.has(normalizedPath);
          });
        }
        
        for (const [index, file] of filteredFiles.entries()) {
          try {
            // Send progress for each file
            await sendProgress({
              type: 'file-progress',
              current: index + 1,
              total: filteredFiles.length,
              fileName: file.path,
              action: 'creating'
            });

            const writable = assertWritableGenerationFile({
              path: file.path,
              content: file.content,
            });
            // Normalize the file path
            let normalizedPath = writable.path;
            if (normalizedPath.startsWith('/')) {
              normalizedPath = normalizedPath.substring(1);
            }
            if (shouldForceSrcPrefix(stackDef.id) &&
              !normalizedPath.startsWith('src/') &&
              !normalizedPath.startsWith('public/') &&
              normalizedPath !== 'index.html' &&
              !isStackConfigFile(stackDef.id, normalizedPath)) {
              normalizedPath = 'src/' + normalizedPath;
            }

            const isUpdate = global.existingFiles.has(normalizedPath);

            // Remove any CSS imports from JSX/JS files (we're using Tailwind)
            let fileContent = writable.content;
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

            // Create directory if needed
            const dirPath = normalizedPath.includes('/') ? normalizedPath.substring(0, normalizedPath.lastIndexOf('/')) : '';
            if (dirPath) {
              await providerInstance.runCommand(`mkdir -p ${dirPath}`);
            }

            // Write the file using provider
            await providerInstance.writeFile(normalizedPath, fileContent);

            // Update file cache
            if (global.sandboxState?.fileCache) {
              global.sandboxState.fileCache.files[normalizedPath] = {
                content: fileContent,
                lastModified: Date.now()
              };
            }

            if (isUpdate) {
              if (results.filesUpdated) results.filesUpdated.push(normalizedPath);
            } else {
              if (results.filesCreated) results.filesCreated.push(normalizedPath);
              if (global.existingFiles) global.existingFiles.add(normalizedPath);
            }

            await sendProgress({
              type: 'file-complete',
              fileName: normalizedPath,
              action: isUpdate ? 'updated' : 'created'
            });
          } catch (error) {
            const message = (error as Error).message;
            if (results.errors) {
              results.errors.push(`Failed to create ${file.path}: ${message}`);
            }
            await recordJobStepFailure(applyJobId, {
              key: `write-file:${file.path}`,
              label: `Write ${file.path}`,
              error: message,
            });
            await sendProgress({
              type: 'file-error',
              fileName: file.path,
              error: message
            });
          }
        }

        // Step 3: Execute commands
        const commandsArray = Array.isArray(parsed.commands) ? parsed.commands : [];
        if (commandsArray.length > 0) {
          await sendProgress({
            type: 'step',
            step: 3,
            message: `Executing ${commandsArray.length} commands...`
          });

          for (const [index, cmd] of commandsArray.entries()) {
            try {
              await sendProgress({
                type: 'command-progress',
                current: index + 1,
                total: parsed.commands.length,
                command: cmd,
                action: 'executing'
              });

              // Use provider runCommand
              const result = await providerInstance.runCommand(cmd);

              // Get command output from provider result
              const stdout = result.stdout;
              const stderr = result.stderr;

              if (stdout) {
                await sendProgress({
                  type: 'command-output',
                  command: cmd,
                  output: stdout,
                  stream: 'stdout'
                });
              }

              if (stderr) {
                await sendProgress({
                  type: 'command-output',
                  command: cmd,
                  output: stderr,
                  stream: 'stderr'
                });
              }

              if (results.commandsExecuted) {
                results.commandsExecuted.push(cmd);
              }

              await sendProgress({
                type: 'command-complete',
                command: cmd,
                exitCode: result.exitCode,
                success: result.exitCode === 0
              });
            } catch (error) {
              if (results.errors) {
                results.errors.push(`Failed to execute ${cmd}: ${(error as Error).message}`);
              }
              await sendProgress({
                type: 'command-error',
                command: cmd,
                error: (error as Error).message
              });
            }
          }
        }

        // Send final results. File-write misses get a warning frame so the
        // workspace chat (which ignores complete.message) sees the same sentence.
        const outcome = applyOutcome({
          filesCreated: results.filesCreated,
          filesUpdated: results.filesUpdated,
          errors: results.errors,
        });
        if (outcome.warning) {
          await sendProgress({ type: 'warning', message: outcome.warning });
        }
        await sendProgress({
          type: 'complete',
          results,
          explanation: parsed.explanation,
          structure: parsed.structure,
          message: outcome.message
        });

        // Track applied files in conversation state
        if (global.conversationState && results.filesCreated.length > 0) {
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
              filesAffected: results.filesCreated || []
            });
          }

          global.conversationState.lastUpdated = Date.now();
        }

      } catch (error) {
        // Set before anything that can throw. When `sendProgress` still threw on a dead
        // stream, this line was skipped and the `finally` below marked a failed apply
        // SUCCEEDED.
        applyFailed = true;
        const message = error instanceof Error ? error.message : String(error);
        await sendProgress({ type: 'error', error: message });
        if (applyJobId) {
          try {
            await failJob(applyJobId, {
              errorCode: 'provider_error',
              errorMessage: message,
            });
          } catch (settleError) {
            await reportSettleFailure({ jobId: applyJobId, intended: 'failed', error: settleError });
          }
        }
      } finally {
        // Order matters. `writer.close()` rejects when the readable was cancelled, and it
        // used to sit ahead of the lock release — which is also what stops both heartbeats,
        // so a disconnect left the project lock renewing itself every 60 seconds and the job
        // heartbeat vouching for work nobody was watching. Cleanup that must happen runs
        // first; the close is last and cannot skip anything.
        applyJobHeartbeat?.stop();
        if (applyJobId && !applyFailed) {
          try {
            await succeedJob(applyJobId);
          } catch (settleError) {
            await reportSettleFailure({
              jobId: applyJobId,
              intended: 'succeeded',
              error: settleError,
            });
          }
        }
        // Last-resort terminal write. A no-op unless the work was torn down rather than
        // finished or thrown, which is the one case neither branch above covers.
        await ensureJobSettled(applyJobId, {
          errorCode: 'client_disconnected',
          errorMessage: clientDisconnectReason
            ? `Client disconnected before the apply finished (${clientDisconnectReason})`
            : 'Client disconnected before the apply finished',
        });
        await releaseApplyLock?.();
        // Deliberately not awaited: `close()` waits for queued chunks to drain and a client
        // that stopped reading never drains them, so awaiting it would park the handler all
        // over again just past the settle.
        void writer.close().catch(() => undefined);
      }
    })(provider, request).catch((error: unknown) => {
      // The IIFE is detached, so anything escaping it is an unhandled rejection.
      log.error('apply.detached_work_failed', {
        jobId: applyJobId,
        error: error instanceof Error ? error.message : String(error),
      });
    });

    // Return the stream
    return new Response(stream.readable, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });

  } catch (error) {
    // Anything thrown after the job row exists used to leave it RUNNING, so the chat stayed
    // locked until the reaper noticed the stopped heartbeat. Settle it here instead.
    applyJobHeartbeat?.stop();
    await ensureJobSettled(applyJobId, {
      errorCode: 'provider_error',
      errorMessage: error instanceof Error ? error.message : 'Failed to parse AI code',
    });
    await releaseApplyLock?.();
    return jsonError(error instanceof Error ? error.message : 'Failed to parse AI code', 'APPLY_FAILED', 500);
  }
}