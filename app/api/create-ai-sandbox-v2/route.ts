import { NextRequest, NextResponse } from 'next/server';
import { SandboxFactory } from '@/lib/sandbox/factory';
// SandboxProvider type is used through SandboxFactory
import type { SandboxState } from '@/types/sandbox';
import { sandboxManager } from '@/lib/sandbox/sandbox-manager';
import { resolveRequestStack } from '@/lib/stack-resolve';
import { getStack } from '@/lib/stacks';

// Store active sandbox globally
declare global {
  var activeSandboxProvider: any;
  var sandboxData: any;
  var existingFiles: Set<string>;
  var sandboxState: SandboxState;
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      stack?: unknown;
      projectId?: unknown;
    };
    // projectId present → always Project.stack from DB.
    // stack present (no projectId) → that stack.
    // neither → REACT. Invalid ids throw; no silent React fallback.
    const stack = await resolveRequestStack({
      stack: body.stack,
      projectId: body.projectId,
    });
    const stackDef = getStack(stack);

    console.log('[create-ai-sandbox-v2] Creating sandbox...');
    console.log('[create-ai-sandbox-v2] stack:', stackDef.id, 'dev:', stackDef.devCommand, 'template:', stackDef.sandboxTemplate);
    
    // Clean up all existing sandboxes
    console.log('[create-ai-sandbox-v2] Cleaning up existing sandboxes...');
    await sandboxManager.terminateAll();
    
    // Also clean up legacy global state
    if (global.activeSandboxProvider) {
      try {
        await global.activeSandboxProvider.terminate();
      } catch (e) {
        console.error('Failed to terminate legacy global sandbox:', e);
      }
      global.activeSandboxProvider = null;
    }
    
    // Clear existing files tracking
    if (global.existingFiles) {
      global.existingFiles.clear();
    } else {
      global.existingFiles = new Set<string>();
    }

    // Create new sandbox using factory
    const provider = SandboxFactory.create();
    const sandboxInfo = await provider.createSandbox(stackDef.id);
    
    console.log('[create-ai-sandbox-v2] Setting up stack app...', stackDef.id);
    await provider.setupViteApp(stackDef.id);
    
    // Register with sandbox manager
    sandboxManager.registerSandbox(sandboxInfo.sandboxId, provider);
    
    // Also store in legacy global state for backward compatibility
    global.activeSandboxProvider = provider;
    global.sandboxData = {
      sandboxId: sandboxInfo.sandboxId,
      url: sandboxInfo.url,
      stack: stackDef.id,
    };
    
    // Initialize sandbox state
    global.sandboxState = {
      fileCache: {
        files: {},
        lastSync: Date.now(),
        sandboxId: sandboxInfo.sandboxId
      },
      sandbox: provider, // Store the provider instead of raw sandbox
      sandboxData: {
        sandboxId: sandboxInfo.sandboxId,
        url: sandboxInfo.url
      }
    };
    
    console.log('[create-ai-sandbox-v2] Sandbox ready at:', sandboxInfo.url);
    
    return NextResponse.json({
      success: true,
      sandboxId: sandboxInfo.sandboxId,
      url: sandboxInfo.url,
      provider: sandboxInfo.provider,
      stack: stackDef.id,
      message: `Sandbox created and ${stackDef.label} app initialized`,
    });

  } catch (error) {
    console.error('[create-ai-sandbox-v2] Error:', error);
    
    // Clean up on error
    await sandboxManager.terminateAll();
    if (global.activeSandboxProvider) {
      try {
        await global.activeSandboxProvider.terminate();
      } catch (e) {
        console.error('Failed to terminate sandbox on error:', e);
      }
      global.activeSandboxProvider = null;
    }
    
    return NextResponse.json(
      { 
        error: error instanceof Error ? error.message : 'Failed to create sandbox',
        details: error instanceof Error ? error.stack : undefined
      },
      { status: 500 }
    );
  }
}