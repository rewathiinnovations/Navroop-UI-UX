import { SandboxProvider } from './types';
import { SandboxFactory } from './factory';
import {
  isTeardownLeak,
  teardownAlreadyGone,
  teardownProvider,
  type TeardownResult,
} from './teardown';

interface SandboxInfo {
  sandboxId: string;
  provider: SandboxProvider;
  createdAt: Date;
  lastAccessed: Date;
}

class SandboxManager {
  private sandboxes: Map<string, SandboxInfo> = new Map();
  private activeSandboxId: string | null = null;

  /**
   * Get or create a sandbox provider for the given sandbox ID
   */
  async getOrCreateProvider(sandboxId: string): Promise<SandboxProvider> {
    // Check if we already have this sandbox
    const existing = this.sandboxes.get(sandboxId);
    if (existing) {
      existing.lastAccessed = new Date();
      return existing.provider;
    }

    // Try to reconnect to existing sandbox
    
    try {
      const provider = SandboxFactory.create();
      
      const reconnected = await provider.reconnect(sandboxId);
      if (reconnected) {
        this.sandboxes.set(sandboxId, {
          sandboxId,
          provider,
          createdAt: new Date(),
          lastAccessed: new Date()
        });
        this.activeSandboxId = sandboxId;
        return provider;
      }
      return provider;
    } catch (error) {
      console.error(`[SandboxManager] Error reconnecting to sandbox ${sandboxId}:`, error);
      throw error;
    }
  }

  /**
   * Register a new sandbox
   */
  registerSandbox(sandboxId: string, provider: SandboxProvider): void {
    this.sandboxes.set(sandboxId, {
      sandboxId,
      provider,
      createdAt: new Date(),
      lastAccessed: new Date()
    });
    this.activeSandboxId = sandboxId;
  }

  /**
   * Get the active sandbox provider
   */
  getActiveProvider(): SandboxProvider | null {
    if (!this.activeSandboxId) {
      return null;
    }
    
    const sandbox = this.sandboxes.get(this.activeSandboxId);
    if (sandbox) {
      sandbox.lastAccessed = new Date();
      return sandbox.provider;
    }
    
    return null;
  }

  /**
   * Get a specific sandbox provider
   */
  getProvider(sandboxId: string): SandboxProvider | null {
    const sandbox = this.sandboxes.get(sandboxId);
    if (sandbox) {
      sandbox.lastAccessed = new Date();
      return sandbox.provider;
    }
    return null;
  }

  /**
   * Set the active sandbox
   */
  setActiveSandbox(sandboxId: string): boolean {
    if (this.sandboxes.has(sandboxId)) {
      this.activeSandboxId = sandboxId;
      return true;
    }
    return false;
  }

  /**
   * Terminate a sandbox
   */
  async terminateSandbox(sandboxId: string): Promise<TeardownResult> {
    const sandbox = this.sandboxes.get(sandboxId);
    if (!sandbox) return teardownAlreadyGone(sandboxId);
    const outcome = await teardownProvider(sandbox.provider);
    if (!isTeardownLeak(outcome)) {
      this.sandboxes.delete(sandboxId);
      if (this.activeSandboxId === sandboxId) {
        this.activeSandboxId = null;
      }
    }
    return outcome;
  }

  /**
   * Terminate all sandboxes
   */
  async terminateAll(): Promise<TeardownResult[]> {
    const ids = Array.from(this.sandboxes.keys());
    return Promise.all(ids.map((id) => this.terminateSandbox(id)));
  }

  /**
   * Clean up old sandboxes (older than maxAge milliseconds)
   */
  async cleanup(maxAge: number = 3600000): Promise<void> {
    const now = new Date();
    const toDelete: string[] = [];
    
    for (const [id, info] of this.sandboxes.entries()) {
      const age = now.getTime() - info.lastAccessed.getTime();
      if (age > maxAge) {
        toDelete.push(id);
      }
    }
    
    for (const id of toDelete) {
      await this.terminateSandbox(id);
    }
  }
}

// Export singleton instance
export const sandboxManager = new SandboxManager();

// Also maintain backward compatibility with global state
declare global {
  var sandboxManager: SandboxManager;
}

// Ensure the global reference points to our singleton
global.sandboxManager = sandboxManager;