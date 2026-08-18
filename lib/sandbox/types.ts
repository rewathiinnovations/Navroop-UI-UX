import type { TeardownResult } from './teardown';

export interface SandboxFile {
  path: string;
  content: string;
  lastModified?: number;
}

export interface SandboxInfo {
  sandboxId: string;
  url: string;
  provider: 'e2b' | 'modal' | 'daytona';
  createdAt: Date;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  success: boolean;
}

export interface SandboxProviderConfig {
  e2b?: {
    apiKey: string;
    timeoutMs?: number;
    template?: string;
  };
  modal?: {
    tokenId: string;
    tokenSecret: string;
  };
  daytona?: {
    apiKey: string;
    apiUrl?: string;
  };
}

export abstract class SandboxProvider {
  protected config: SandboxProviderConfig;
  protected sandbox: any;
  protected sandboxInfo: SandboxInfo | null = null;

  constructor(config: SandboxProviderConfig) {
    this.config = config;
  }

  /**
   * Create the sandbox VM. Pass the resolved stack so the provider can select
   * `getStack(stack).sandboxTemplate`. Omitting stack defaults to NEXTJS only
   * when neither a stack nor a projectId was provided by the caller.
   */
  abstract createSandbox(stack?: string): Promise<SandboxInfo>;
  abstract runCommand(command: string): Promise<CommandResult>;
  abstract writeFile(path: string, content: string): Promise<void>;
  abstract readFile(path: string): Promise<string>;
  abstract listFiles(directory?: string): Promise<string[]>;
  abstract installPackages(packages: string[]): Promise<CommandResult>;
  abstract getSandboxUrl(): string | null;
  abstract getSandboxInfo(): SandboxInfo | null;
  abstract terminate(): Promise<TeardownResult>;
  abstract isAlive(): boolean;

  /** Probe an existing provider VM. Default: not supported. */
  async reconnect(_sandboxId: string, _timeoutMs?: number): Promise<boolean> {
    return false;
  }

  /**
   * Install (when the stack has node deps) and start the stack dev server
   * without rewriting scaffold files. Used after checkpoint restore.
   */
  async installAndStartDev(_stack?: string): Promise<void> {
    throw new Error('installAndStartDev not implemented for this provider');
  }
  
  // Optional methods that providers can override
  async setupViteApp(_stack?: string): Promise<void> {
    // Default implementation for setting up a Vite React app
    throw new Error('setupViteApp not implemented for this provider');
  }
  
  async restartViteServer(): Promise<void> {
    // Default implementation for restarting Vite
    throw new Error('restartViteServer not implemented for this provider');
  }
}