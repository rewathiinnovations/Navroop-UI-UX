/**
 * Daytona sandbox driver. TS SDK is 0.x — pin the exact version in package.json
 * (`@daytona/sdk@0.205.0`); minor versions may break. 0.128.0 was never published
 * (first tag is 0.161.0-alpha.1).
 *
 * publicPreviewUrl capability is true (`public: true` on create). Auto-stop is
 * set to the app idle reaper (5 min) rather than Daytona's default 15.
 * Pause/archive: treat pause as kill for now (SDK has pause(); a future suspend
 * path would reduce cost by keeping the filesystem).
 *
 * Credentials via constructor (API key), not env, so several accounts can coexist.
 */
import {
  sandboxMissingPreviewUrlMessage,
  sandboxReconnectMissingPreviewUrlMessage,
  sandboxReconnectUncertainMessage,
  usablePreviewUrl,
} from '../boot-errors';
import { commandResultFromDaytonaExecute } from '../daytona-command-result';
import { InjectedCapableProvider } from './injected-base';
import type { CommandResult, SandboxInfo } from '../types';
import { DRIVER_CAPABILITIES, DRIVER_COST_MODELS, type InjectedSandboxClient } from '../provider';
import { DEFAULT_IDLE_MINUTES } from '../minutes';
import {
  runTeardown,
  teardownAlreadyGone,
  type TeardownResult,
} from '../teardown';
import { DEFAULT_STACK } from '@/lib/stacks';
import { appConfig } from '@/config/app.config';
import { base64DecodeWriteCommand } from './shell-file-write';

/** Positive evidence the VM is gone — not a timeout, auth failure, or network blip. */
export function isDaytonaSandboxGone(error: unknown): boolean {
  if (error == null || typeof error !== 'object') return false;
  const name = error instanceof Error ? error.name : '';
  if (name === 'DaytonaNotFoundError' || name === 'DaytonaGoneError') return true;
  const statusCode =
    'statusCode' in error ? Number((error as { statusCode?: unknown }).statusCode) : Number.NaN;
  if (statusCode === 404 || statusCode === 410) return true;
  const message = error instanceof Error ? error.message : '';
  return /\b(404|410)\b/.test(message) || /\bnot found\b/i.test(message) || /\bno longer exists\b/i.test(message);
}

export function daytonaMissingPreviewUrlMessage(
  port: number = appConfig.e2b.vitePort,
  outcome?: TeardownResult,
): string {
  return sandboxMissingPreviewUrlMessage('daytona', port, outcome);
}

type DaytonaSandbox = {
  id?: string;
  process?: {
    executeCommand?: (command: string) => Promise<{ result?: string; exitCode?: number }>;
  };
  fs?: {
    uploadFile?: (src: Buffer | string, dest: string) => Promise<void>;
    downloadFile?: (path: string) => Promise<Buffer | string>;
    listFiles?: (path: string) => Promise<Array<{ name: string }>>;
  };
  getPreviewLink?: (port: number) => Promise<{ url?: string } | string>;
  delete?: () => Promise<void>;
  stop?: () => Promise<void>;
};

type DaytonaSdk = {
  Daytona: new (opts: { apiKey: string; apiUrl?: string; target?: string }) => {
    create: (params?: {
      language?: string;
      public?: boolean;
      autoStopInterval?: number;
    }) => Promise<DaytonaSandbox>;
    get: (id: string) => Promise<DaytonaSandbox>;
    delete?: (sandbox: DaytonaSandbox) => Promise<void>;
  };
};

export class DaytonaProvider extends InjectedCapableProvider {
  readonly driver = 'daytona' as const;
  readonly capabilities = DRIVER_CAPABILITIES.daytona;
  readonly costModel = DRIVER_COST_MODELS.daytona;
  private apiKey: string;
  private apiUrl?: string;
  private live: DaytonaSandbox | null = null;

  constructor(credentials: { apiKey: string; apiUrl?: string }, options?: { client?: InjectedSandboxClient }) {
    super({ daytona: credentials });
    this.apiKey = credentials.apiKey;
    this.apiUrl = credentials.apiUrl;
    this.bindInjected(options?.client);
  }

  async createSandbox(stack: string = DEFAULT_STACK): Promise<SandboxInfo> {
    if (this.injected) {
      return this.fromInjectedCreate(await this.injected.create({ stack }));
    }
    const port = appConfig.e2b.vitePort;
    try {
      const sdk = await loadDaytonaSdk();
      const client = new sdk.Daytona({ apiKey: this.apiKey, apiUrl: this.apiUrl });
      this.live = await client.create({
        language: 'typescript',
        public: true,
        autoStopInterval: DEFAULT_IDLE_MINUTES,
      });
      const id = this.live.id || `daytona-${Date.now()}`;
      const link = await this.live.getPreviewLink?.(port);
      const url = (typeof link === 'string' ? link : link?.url || '').trim();
      if (!url) {
        const outcome = await this.terminateLive();
        throw new Error(daytonaMissingPreviewUrlMessage(port, outcome));
      }
      this.sandbox = this.live;
      this.sandboxInfo = { sandboxId: id, url, provider: 'daytona', createdAt: new Date() };
      return this.sandboxInfo;
    } catch (error) {
      await this.terminateLive();
      throw error;
    }
  }

  protected async runCommandLive(command: string): Promise<CommandResult> {
    if (!this.live?.process?.executeCommand) throw new Error('No active sandbox');
    const result = await this.live.process.executeCommand(command);
    return commandResultFromDaytonaExecute(result);
  }

  protected async writeFileLive(path: string, content: string): Promise<void> {
    if (this.live?.fs?.uploadFile) {
      await this.live.fs.uploadFile(Buffer.from(content), path);
      return;
    }
    await this.runCommandLive(base64DecodeWriteCommand(path, content));
  }

  protected async readFileLive(path: string): Promise<string> {
    if (this.live?.fs?.downloadFile) {
      const data = await this.live.fs.downloadFile(path);
      return typeof data === 'string' ? data : data.toString('utf8');
    }
    const result = await this.runCommandLive(`cat ${JSON.stringify(path)}`);
    return result.stdout;
  }

  protected async listFilesLive(directory = '.'): Promise<string[]> {
    if (this.live?.fs?.listFiles) {
      const files = await this.live.fs.listFiles(directory);
      return files.map((file) => file.name);
    }
    const result = await this.runCommandLive(`find ${JSON.stringify(directory)} -type f`);
    return result.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  }

  protected async terminateLive(): Promise<TeardownResult> {
    // Pause/archive: treat pause as kill for now (SDK 0.205.0 has pause()).
    // A future suspend path would reduce cost by keeping the filesystem.
    const sandboxId = this.sandboxInfo?.sandboxId ?? this.live?.id ?? null;
    if (!this.live) return teardownAlreadyGone(sandboxId);
    const live = this.live;
    const outcome = await runTeardown(
      sandboxId,
      async () => {
        if (live.delete) await live.delete();
        else if (live.stop) await live.stop();
      },
      isDaytonaSandboxGone,
    );
    if (outcome.status !== 'could_not_stop') {
      this.live = null;
      this.sandbox = null;
      this.sandboxInfo = null;
    }
    return outcome;
  }

  protected async reconnectLive(sandboxId: string): Promise<boolean> {
    const port = appConfig.e2b.vitePort;
    const missingUrl = sandboxReconnectMissingPreviewUrlMessage('daytona', port);
    try {
      const sdk = await loadDaytonaSdk();
      const client = new sdk.Daytona({ apiKey: this.apiKey, apiUrl: this.apiUrl });
      const existing = await client.get(sandboxId);
      if (!existing) return false;
      const link = await existing.getPreviewLink?.(port);
      const raw = typeof link === 'string' ? link : link?.url;
      const url = usablePreviewUrl(raw);
      if (!url) {
        throw new Error(missingUrl);
      }
      this.live = existing;
      this.sandbox = existing;
      this.sandboxInfo = { sandboxId, url, provider: 'daytona', createdAt: new Date() };
      return true;
    } catch (error) {
      this.live = null;
      this.sandbox = null;
      this.sandboxInfo = null;
      if (error instanceof Error && error.message === missingUrl) throw error;
      if (isDaytonaSandboxGone(error)) return false;
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(sandboxReconnectUncertainMessage('daytona', detail));
    }
  }
}

async function loadDaytonaSdk(): Promise<DaytonaSdk> {
  try {
    return (await import('@daytona/sdk')) as unknown as DaytonaSdk;
  } catch {
    throw new Error(
      '@daytona/sdk is not installed. Coordinator: stop :3000, pnpm add @daytona/sdk@0.205.0, then restart (no prisma generate).',
    );
  }
}
