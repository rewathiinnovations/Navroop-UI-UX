/**
 * Modal sandbox driver. JS SDK is 0.x — pin the exact version in package.json;
 * minor versions may break.
 *
 * Credentials via constructor (token id + secret), not env, so several Modal
 * accounts can coexist.
 */
import { InjectedCapableProvider } from './injected-base';
import type { CommandResult, SandboxInfo } from '../types';
import { DRIVER_CAPABILITIES, DRIVER_COST_MODELS, type InjectedSandboxClient } from '../provider';
import { DEFAULT_STACK } from '@/lib/stacks';
import { appConfig } from '@/config/app.config';
import {
  sandboxMissingPreviewUrlMessage,
  sandboxReconnectMissingPreviewUrlMessage,
  sandboxReconnectUncertainMessage,
  usablePreviewUrl,
} from '../boot-errors';
import {
  runTeardown,
  teardownAlreadyGone,
  unusedSandboxTeardownSuffix,
  type TeardownResult,
} from '../teardown';
import { absoluteSandboxPath } from './sandbox-path';

/** Positive evidence the VM is gone — not a timeout, auth failure, or network blip. */
export function isModalSandboxGone(error: unknown): boolean {
  if (error == null || typeof error !== 'object') return false;
  const name = error instanceof Error ? error.name : '';
  if (name === 'SandboxFilesystemNotFoundError') return false;
  if (name === 'NotFoundError') return true;
  const statusCode =
    'statusCode' in error ? Number((error as { statusCode?: unknown }).statusCode) : Number.NaN;
  if (statusCode === 404 || statusCode === 410) return true;
  const message = error instanceof Error ? error.message : '';
  return /\b(404|410)\b/.test(message) || /\bnot found\b/i.test(message) || /\bno longer exists\b/i.test(message);
}

/** Vite port the sandbox boot starts (`setupViteApp` / E2B vite.config). */
export const SANDBOX_DEV_SERVER_PORT = appConfig.e2b.vitePort;

/**
 * Official Node 20 image (same major as CI, the Dockerfile, and `@types/node`).
 * `setupViteApp` / `installPackages` / `restartDevServer` shell `npm install`,
 * `npm run dev`, `next dev`, and `vite` — none of those exist on python:3.12-slim.
 * Modal's live path is `sh -c`, so this image does not need Python.
 */
export const MODAL_SANDBOX_IMAGE = 'node:20';

export function modalMissingPreviewUrlMessage(
  port: number = SANDBOX_DEV_SERVER_PORT,
  outcome?: TeardownResult,
): string {
  return sandboxMissingPreviewUrlMessage('modal', port, outcome);
}

export function modalMissingDevBinariesMessage(outcome?: TeardownResult): string {
  return (
    'Modal created a sandbox but the image cannot run the Vite dev server (node and npm are required). ' +
    unusedSandboxTeardownSuffix('Modal', outcome)
  );
}

/** modal@0.9.0: Tunnel.url, ContainerProcess streams + wait(), Sandbox.sandboxId. */
type ModalTunnel = {
  url: string;
};

type ModalProcess = {
  stdout: { readText: () => Promise<string> };
  stderr: { readText: () => Promise<string> };
  wait: () => Promise<number>;
};

type ModalFilesystem = {
  writeText: (data: string, remotePath: string) => Promise<void>;
  readText: (remotePath: string) => Promise<string>;
};

type ModalSandbox = {
  sandboxId: string;
  exec: (command: string[], opts?: Record<string, unknown>) => Promise<ModalProcess>;
  terminate: () => Promise<void>;
  tunnels: (timeoutMs?: number) => Promise<Record<number, ModalTunnel>>;
  filesystem: ModalFilesystem;
};

type ModalSdk = {
  ModalClient: new (opts: { tokenId: string; tokenSecret: string }) => {
    apps: { fromName: (name: string, opts?: { createIfMissing?: boolean }) => Promise<unknown> };
    images: { fromRegistry: (image: string) => unknown };
    sandboxes: {
      create: (
        app: unknown,
        image: unknown,
        opts?: { timeoutMs?: number; encryptedPorts?: number[] },
      ) => Promise<ModalSandbox>;
      fromId: (sandboxId: string) => Promise<ModalSandbox>;
    };
  };
};

export class ModalProvider extends InjectedCapableProvider {
  readonly driver = 'modal' as const;
  readonly capabilities = DRIVER_CAPABILITIES.modal;
  readonly costModel = DRIVER_COST_MODELS.modal;
  private tokenId: string;
  private tokenSecret: string;
  private live: ModalSandbox | null = null;

  constructor(
    credentials: { tokenId: string; tokenSecret: string },
    options?: { client?: InjectedSandboxClient },
  ) {
    super({ modal: credentials });
    this.tokenId = credentials.tokenId;
    this.tokenSecret = credentials.tokenSecret;
    this.bindInjected(options?.client);
  }

  async createSandbox(stack: string = DEFAULT_STACK): Promise<SandboxInfo> {
    if (this.injected) {
      return this.fromInjectedCreate(await this.injected.create({ stack }));
    }
    const port = SANDBOX_DEV_SERVER_PORT;
    try {
      const modal = await loadModalSdk();
      const client = new modal.ModalClient({ tokenId: this.tokenId, tokenSecret: this.tokenSecret });
      const app = await client.apps.fromName('navroop-sandbox', { createIfMissing: true });
      const image = client.images.fromRegistry(MODAL_SANDBOX_IMAGE);
      this.live = await client.sandboxes.create(app, image, {
        timeoutMs: 5 * 60 * 1000,
        encryptedPorts: [port],
      });
      const id = this.live.sandboxId;
      const tunnels = await this.live.tunnels();
      const url = tunnels[port]?.url?.trim() || '';
      if (!url) {
        const outcome = await this.terminateLive();
        throw new Error(modalMissingPreviewUrlMessage(port, outcome));
      }
      const probe = await this.runCommandLive('command -v node && command -v npm');
      if (!probe.success) {
        const outcome = await this.terminateLive();
        throw new Error(modalMissingDevBinariesMessage(outcome));
      }
      this.sandbox = this.live;
      this.sandboxInfo = { sandboxId: id, url, provider: 'modal', createdAt: new Date() };
      return this.sandboxInfo;
    } catch (error) {
      // createWithFailover discards this instance when createSandbox throws, so
      // manager.ts never sees a handle to terminate. Stop the VM here or it bills.
      await this.terminateLive();
      throw error;
    }
  }

  protected async runCommandLive(command: string): Promise<CommandResult> {
    if (!this.live) throw new Error('No active sandbox');
    const containerProcess = await this.live.exec(['sh', '-c', command]);
    const [stdout, stderr, exitCode] = await Promise.all([
      containerProcess.stdout.readText(),
      containerProcess.stderr.readText(),
      containerProcess.wait(),
    ]);
    return {
      stdout,
      stderr,
      exitCode,
      success: exitCode === 0,
    };
  }

  protected async writeFileLive(path: string, content: string): Promise<void> {
    if (!this.live) throw new Error('No active sandbox');
    // modal@0.9.0 Sandbox#filesystem.writeText(data, absolutePath) pipes
    // UTF-8 bytes on stdin. Do not printf JSON.stringify — that writes
    // literal backslash-n ({\n  "name": "sandbox...).
    await this.live.filesystem.writeText(content, absoluteSandboxPath(path));
  }

  protected async readFileLive(path: string): Promise<string> {
    if (!this.live) throw new Error('No active sandbox');
    return this.live.filesystem.readText(absoluteSandboxPath(path));
  }

  protected async listFilesLive(directory = '.'): Promise<string[]> {
    const result = await this.runCommandLive(`find ${JSON.stringify(directory)} -type f`);
    return result.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  }

  protected async terminateLive(): Promise<TeardownResult> {
    const sandboxId = this.sandboxInfo?.sandboxId ?? this.live?.sandboxId ?? null;
    if (!this.live) return teardownAlreadyGone(sandboxId);
    const live = this.live;
    const outcome = await runTeardown(sandboxId, () => live.terminate(), isModalSandboxGone);
    if (outcome.status !== 'could_not_stop') {
      this.live = null;
      this.sandbox = null;
      this.sandboxInfo = null;
    }
    return outcome;
  }

  protected async reconnectLive(sandboxId: string): Promise<boolean> {
    const port = SANDBOX_DEV_SERVER_PORT;
    const missingUrl = sandboxReconnectMissingPreviewUrlMessage('modal', port);
    try {
      const modal = await loadModalSdk();
      const client = new modal.ModalClient({ tokenId: this.tokenId, tokenSecret: this.tokenSecret });
      // fromId builds a local handle and does not hit the network; tunnels() is the lookup.
      const existing = await client.sandboxes.fromId(sandboxId);
      const tunnels = await existing.tunnels();
      const url = usablePreviewUrl(tunnels[port]?.url);
      if (!url) {
        throw new Error(missingUrl);
      }
      this.live = existing;
      this.sandbox = existing;
      this.sandboxInfo = { sandboxId, url, provider: 'modal', createdAt: new Date() };
      return true;
    } catch (error) {
      this.live = null;
      this.sandbox = null;
      this.sandboxInfo = null;
      if (error instanceof Error && error.message === missingUrl) throw error;
      if (isModalSandboxGone(error)) return false;
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(sandboxReconnectUncertainMessage('modal', detail));
    }
  }
}

async function loadModalSdk(): Promise<ModalSdk> {
  try {
    return (await import('modal')) as unknown as ModalSdk;
  } catch {
    throw new Error(
      'modal SDK is not installed. Coordinator: stop :3000, pnpm add modal@0.9.0, then prisma generate and restart.',
    );
  }
}
