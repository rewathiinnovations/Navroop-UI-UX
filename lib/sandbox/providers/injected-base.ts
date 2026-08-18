import { SandboxProvider, SandboxInfo, CommandResult } from '../types';
import type { InjectedSandboxClient, SandboxDriverId } from '../provider';
import { lastCommandOutput, sandboxNpmInstallFailedMessage } from '../boot-errors';
import {
  runTeardown,
  teardownProvider,
  type TeardownResult,
} from '../teardown';

export abstract class InjectedCapableProvider extends SandboxProvider {
  protected injected: InjectedSandboxClient | null = null;
  abstract readonly driver: SandboxDriverId;

  protected bindInjected(client?: InjectedSandboxClient) {
    this.injected = client ?? null;
  }

  protected fromInjectedCreate(created: { id: string; previewUrl?: string | null }): SandboxInfo {
    this.sandbox = { injected: true };
    this.sandboxInfo = {
      sandboxId: created.id,
      url: created.previewUrl || this.injected?.getPreviewUrl() || '',
      provider: this.driver,
      createdAt: new Date(),
    };
    return this.sandboxInfo;
  }

  async runCommand(command: string): Promise<CommandResult> {
    if (this.injected) {
      const result = await this.injected.run(command);
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        success: result.exitCode === 0,
      };
    }
    return this.runCommandLive(command);
  }

  async writeFile(path: string, content: string): Promise<void> {
    if (this.injected) {
      await this.injected.writeFile(path, content);
      return;
    }
    await this.writeFileLive(path, content);
  }

  async readFile(path: string): Promise<string> {
    if (this.injected) return this.injected.readFile(path);
    return this.readFileLive(path);
  }

  async listFiles(directory?: string): Promise<string[]> {
    if (this.injected) return this.injected.listFiles(directory);
    return this.listFilesLive(directory);
  }

  async terminate(): Promise<TeardownResult> {
    if (this.injected) {
      const sandboxId = this.sandboxInfo?.sandboxId ?? null;
      const outcome = await runTeardown(sandboxId, () => this.injected!.kill(), () => false);
      if (outcome.status !== 'could_not_stop') {
        this.sandbox = null;
        this.sandboxInfo = null;
      }
      return outcome;
    }
    return this.terminateLive();
  }

  async reconnect(sandboxId: string, _timeoutMs?: number): Promise<boolean> {
    if (this.injected) {
      const alive = await this.injected.reconnect(sandboxId);
      if (alive) {
        this.sandbox = { injected: true };
        this.sandboxInfo = {
          sandboxId,
          url: this.injected.getPreviewUrl() || '',
          provider: this.driver,
          createdAt: new Date(),
        };
      }
      return alive;
    }
    return this.reconnectLive(sandboxId);
  }

  getSandboxUrl(): string | null {
    if (this.injected) return this.injected.getPreviewUrl() || this.sandboxInfo?.url || null;
    return this.sandboxInfo?.url || null;
  }

  getSandboxInfo(): SandboxInfo | null {
    return this.sandboxInfo;
  }

  isAlive(): boolean {
    return Boolean(this.sandbox);
  }

  async installPackages(packages: string[]): Promise<CommandResult> {
    if (packages.length === 0) {
      return { stdout: '', stderr: '', exitCode: 0, success: true };
    }
    return this.runCommand(`npm install ${packages.join(' ')}`);
  }

  protected async assertInstallSucceeded(result: CommandResult): Promise<void> {
    if (result.success && result.exitCode === 0) return;
    const output = lastCommandOutput(result.stdout, result.stderr);
    const outcome = await teardownProvider(this);
    const message = sandboxNpmInstallFailedMessage(this.driver, result.exitCode, output, outcome);
    throw new Error(message);
  }

  async setupViteApp(stack?: string): Promise<void> {
    const { getStackSetupPlan, stackScaffoldFiles } = await import('../stack-setup');
    const plan = getStackSetupPlan(stack || 'NEXTJS');
    for (const file of stackScaffoldFiles(plan.stack)) {
      await this.writeFile(file.path, file.content);
    }
    if (!plan.skipInstall && plan.installCommand) {
      const install = await this.runCommand(plan.installCommand);
      await this.assertInstallSucceeded(install);
    }
    await this.runCommand(`${plan.devCommand} &`);
  }

  async installAndStartDev(stack?: string): Promise<void> {
    const { getStackSetupPlan } = await import('../stack-setup');
    const plan = getStackSetupPlan(stack || 'NEXTJS');
    if (!plan.skipInstall && plan.installCommand) {
      const install = await this.runCommand(plan.installCommand);
      await this.assertInstallSucceeded(install);
    }
    await this.runCommand(`${plan.devCommand} &`);
  }

  async restartViteServer(): Promise<void> {
    try {
      await this.runCommand('pkill -f vite');
    } catch {
      // No existing Vite process is fine — we still start a new one.
    }
    await this.runCommand('sh -c "nohup npm run dev > /tmp/vite.log 2>&1 &"');
  }

  protected abstract runCommandLive(command: string): Promise<CommandResult>;
  protected abstract writeFileLive(path: string, content: string): Promise<void>;
  protected abstract readFileLive(path: string): Promise<string>;
  protected abstract listFilesLive(directory?: string): Promise<string[]>;
  protected abstract terminateLive(): Promise<TeardownResult>;
  protected abstract reconnectLive(sandboxId: string): Promise<boolean>;
}
