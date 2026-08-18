import { describe, expect, it, vi } from 'vitest';

/**
 * `tests/sandbox-providers.test.ts` builds ModalProvider with an InjectedSandboxClient,
 * so `this.injected` short-circuits before `createSandbox` or `runCommandLive` touch
 * the SDK. Those bugs stay green forever on that path.
 *
 * This file drives the real live methods against a thin fake of modal@0.9.0:
 * `tunnels()` is a method returning `Record<number, { url }>`, and `exec` returns a
 * ContainerProcess whose stdout/stderr are streams with `readText()` and whose exit
 * code comes from `wait()`. No network, no real Modal client.
 */

type FakeTunnelMap = Record<number, { url: string }>;

const fake = vi.hoisted(() => {
  const state: {
    sandboxId: string;
    tunnels: FakeTunnelMap;
    tunnelsError: Error | null;
    stdout: string;
    stderr: string;
    exitCode: number;
    createParams: Record<string, unknown> | undefined;
    imageTag: string | undefined;
    execCommands: string[][];
    terminateCalls: number;
    terminateError: Error | null;
    written: Record<string, string>;
    fsWrites: Array<{ data: string; remotePath: string }>;
  } = {
    sandboxId: 'sb-modal-live-1',
    tunnels: { 5173: { url: 'https://preview.example.com' } },
    tunnelsError: null,
    stdout: 'ok\n',
    stderr: '',
    exitCode: 0,
    createParams: undefined,
    imageTag: undefined,
    execCommands: [],
    terminateCalls: 0,
    terminateError: null as Error | null,
    written: {},
    fsWrites: [],
  };

  return {
    state,
    reset() {
      state.sandboxId = 'sb-modal-live-1';
      state.tunnels = { 5173: { url: 'https://preview.example.com' } };
      state.tunnelsError = null;
      state.stdout = 'ok\n';
      state.stderr = '';
      state.exitCode = 0;
      state.createParams = undefined;
      state.imageTag = undefined;
      state.execCommands = [];
      state.terminateCalls = 0;
      state.terminateError = null;
      state.written = {};
      state.fsWrites = [];
    },
    sandbox: {
      get sandboxId() {
        return state.sandboxId;
      },
      async tunnels() {
        if (state.tunnelsError) throw state.tunnelsError;
        return state.tunnels;
      },
      async exec(command: string[]) {
        state.execCommands.push(command);
        const script = command[2] ?? '';
        const captured = capturePrintfJsonWrite(script);
        if (captured) {
          state.written[captured.path] = captured.landed;
        }
        return {
          stdout: { readText: async () => state.stdout },
          stderr: { readText: async () => state.stderr },
          wait: async () => state.exitCode,
        };
      },
      filesystem: {
        async writeText(data: string, remotePath: string) {
          state.fsWrites.push({ data, remotePath });
          state.written[remotePath] = data;
        },
        async readText(remotePath: string) {
          if (!(remotePath in state.written)) {
            throw new Error(`missing ${remotePath}`);
          }
          return state.written[remotePath];
        },
      },
      async terminate() {
        state.terminateCalls += 1;
        if (state.terminateError) throw state.terminateError;
      },
    },
  };
});

/**
 * Reproduce what `printf %s ${JSON.stringify(content)}` actually writes:
 * JSON.stringify turns newlines into the two characters `\` and `n`, and bash
 * double quotes do not interpret `\n`, so the file gets a literal backslash-n.
 */
function capturePrintfJsonWrite(script: string): { path: string; landed: string } | null {
  const marker = 'printf %s ';
  const idx = script.indexOf(marker);
  if (idx === -1) return null;
  const redirect = / > ("(?:\\.|[^"\\])*")\s*$/;
  const match = script.match(redirect);
  if (!match || match.index === undefined) return null;
  const path = JSON.parse(match[1]) as string;
  const escaped = script.slice(idx + marker.length, match.index).trim();
  return { path, landed: bashDoubleQuotedJsonLiteral(escaped) };
}

function bashDoubleQuotedJsonLiteral(jsonQuoted: string): string {
  const inner = jsonQuoted.startsWith('"') && jsonQuoted.endsWith('"')
    ? jsonQuoted.slice(1, -1)
    : jsonQuoted;
  let out = '';
  for (let i = 0; i < inner.length; i += 1) {
    if (inner[i] === '\\' && i + 1 < inner.length) {
      const next = inner[i + 1];
      if (next === '"' || next === '\\') {
        out += next;
        i += 1;
        continue;
      }
    }
    out += inner[i];
  }
  return out;
}

vi.mock('modal', () => ({
  ModalClient: class ModalClient {
    constructor(_opts: { tokenId: string; tokenSecret: string }) {}
    apps = {
      fromName: async () => ({ appId: 'app-surface' }),
    };
    images = {
      fromRegistry: (tag: string) => {
        fake.state.imageTag = tag;
        return { imageId: 'img-surface' };
      },
    };
    sandboxes = {
      create: async (_app: unknown, _image: unknown, params?: Record<string, unknown>) => {
        fake.state.createParams = params;
        return fake.sandbox;
      },
    };
  },
}));

const { ModalProvider, modalMissingDevBinariesMessage, modalMissingPreviewUrlMessage } =
  await import('@/lib/sandbox/providers/modal-provider');
import { appConfig } from '@/config/app.config';

const vitePort = appConfig.e2b.vitePort;
const STOPPED = { status: 'stopped' as const, sandboxId: 'sb-modal-live-1' };
const LEAKED = {
  status: 'could_not_stop' as const,
  reason: 'terminate refused',
  sandboxId: 'sb-modal-live-1',
};
const MISSING_PREVIEW_URL = modalMissingPreviewUrlMessage(vitePort, STOPPED);
const MISSING_DEV_BINARIES = modalMissingDevBinariesMessage(STOPPED);
const MISSING_PREVIEW_URL_LEAKED = modalMissingPreviewUrlMessage(vitePort, LEAKED);
const MISSING_DEV_BINARIES_LEAKED = modalMissingDevBinariesMessage(LEAKED);
/** Repo CI, Dockerfile, and @types/node all target Node 20. Official node:20 ships node, npm, and npx. */
const NODE_20_IMAGE = 'node:20';

function liveProvider() {
  fake.reset();
  return new ModalProvider({ tokenId: 'ak-not-real', tokenSecret: 'as-not-real' });
}

describe('ModalProvider live path against the modal@0.9.0 SDK shape', () => {
  it('requests the Vite port at create so tunnels() can return a preview URL', async () => {
    const provider = liveProvider();
    const created = await provider.createSandbox();

    expect(fake.state.createParams?.encryptedPorts).toEqual([vitePort]);
    expect(created.sandboxId).toBe('sb-modal-live-1');
    expect(created.url).toBe('https://preview.example.com');
    expect(provider.getSandboxUrl()).toBe('https://preview.example.com');
    expect(fake.state.terminateCalls).toBe(0);
  });

  it('boots a Node 20 image so setupViteApp can run npm install and the Vite/Next dev server', async () => {
    // setupViteApp (injected-base) shells `npm install` then `next dev` / `vite --host`.
    // python:3.12-slim has neither binary. modal@0.9.0 ImageService.fromRegistry(tag)
    // takes a Docker Hub tag — prefer a Node base over dockerfileCommands on Python.
    const provider = liveProvider();
    await provider.createSandbox();

    expect(fake.state.imageTag).toBe(NODE_20_IMAGE);
    expect(fake.state.imageTag).not.toMatch(/^python:/);
  });

  it('fails by name and stops the sandbox when node or npm is missing after boot', async () => {
    const provider = liveProvider();
    fake.state.exitCode = 1;

    await expect(provider.createSandbox()).rejects.toThrow(MISSING_DEV_BINARIES);
    expect(MISSING_DEV_BINARIES).toContain('The unused sandbox was stopped so it is not billed.');
    expect(MISSING_DEV_BINARIES).not.toContain('was asked to stop');
    expect(fake.state.terminateCalls).toBe(1);
    expect(provider.getSandboxUrl()).toBeNull();
    expect(provider.isAlive()).toBe(false);
    expect(fake.state.execCommands.some((command) => command.join(' ').includes('node'))).toBe(
      true,
    );
  });

  it('keeps the missing-binaries cause and says the VM may still be billed when terminate leaks', async () => {
    const provider = liveProvider();
    fake.state.exitCode = 1;
    fake.state.terminateError = new Error('terminate refused');

    await expect(provider.createSandbox()).rejects.toThrow(MISSING_DEV_BINARIES_LEAKED);
    expect(MISSING_DEV_BINARIES_LEAKED).toContain('node and npm are required');
    expect(MISSING_DEV_BINARIES_LEAKED).toContain('The sandbox could not be shut down and may still be billed.');
    expect(MISSING_DEV_BINARIES_LEAKED).not.toContain('was asked to stop');
    expect((provider as unknown as { live: unknown }).live).not.toBeNull();
  });

  it('fails by name and stops the sandbox when tunnels() has no Vite port', async () => {
    const provider = liveProvider();
    fake.state.tunnels = { 8080: { url: 'https://wrong-port.example.com' } };

    await expect(provider.createSandbox()).rejects.toThrow(MISSING_PREVIEW_URL);
    expect(MISSING_PREVIEW_URL).toContain('The unused sandbox was stopped so it is not billed.');
    expect(MISSING_PREVIEW_URL).not.toContain('was asked to stop');
    expect(fake.state.terminateCalls).toBe(1);
    expect(provider.getSandboxUrl()).toBeNull();
    expect(provider.isAlive()).toBe(false);
  });

  it('keeps the missing-URL cause and says the VM may still be billed when terminate leaks', async () => {
    const provider = liveProvider();
    fake.state.tunnels = { 8080: { url: 'https://wrong-port.example.com' } };
    fake.state.terminateError = new Error('terminate refused');

    await expect(provider.createSandbox()).rejects.toThrow(MISSING_PREVIEW_URL_LEAKED);
    expect(MISSING_PREVIEW_URL_LEAKED).toContain('did not return a preview URL');
    expect(MISSING_PREVIEW_URL_LEAKED).toContain('The sandbox could not be shut down and may still be billed.');
    expect(MISSING_PREVIEW_URL_LEAKED).not.toContain('was asked to stop');
    expect((provider as unknown as { live: unknown }).live).not.toBeNull();
  });

  it('does not swallow a tunnels() failure as an empty preview URL', async () => {
    const provider = liveProvider();
    fake.state.tunnelsError = new Error('tunnels timed out');

    await expect(provider.createSandbox()).rejects.toThrow('tunnels timed out');
    expect(fake.state.terminateCalls).toBe(1);
    expect(provider.getSandboxUrl()).toBeNull();
  });

  it('reads exec stdout/stderr via readText() and the exit code from wait()', async () => {
    const provider = liveProvider();
    await provider.createSandbox();

    fake.state.stdout = 'hello from modal\n';
    fake.state.stderr = 'note\n';
    fake.state.exitCode = 0;

    const result = await provider.runCommand('echo hello');

    expect(result.stdout).toBe('hello from modal\n');
    expect(result.stderr).toBe('note\n');
    expect(result.exitCode).toBe(0);
    expect(result.success).toBe(true);
  });

  it('reports failure when wait() returns a non-zero exit code', async () => {
    const provider = liveProvider();
    await provider.createSandbox();

    fake.state.stdout = '';
    fake.state.stderr = 'boom\n';
    fake.state.exitCode = 7;

    const result = await provider.runCommand('false');

    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('boom\n');
    expect(result.exitCode).toBe(7);
    expect(result.success).toBe(false);
  });
});

/**
 * The live Modal write used `printf %s ${JSON.stringify(content)}`. That is the
 * payload npm printed as `{\n  "name": "sandbox...` — literal backslash-n, not a
 * newline. These cases are the files generation actually writes.
 */
const PACKAGE_JSON = '{\n  "name": "sandbox-app",\n  "private": true\n}\n';
const PRINTF_CORRUPT_PACKAGE_JSON = '{\\n  "name": "sandbox-app",\\n  "private": true\\n}\\n';
const SPECIAL_FILE = [
  'quotes: "hello"',
  'backslash: C:\\tmp\\file',
  'dollar: $HOME and ${PATH}',
  'backticks: `whoami`',
  "single: it's fine",
  'unicode: café — 日本語',
].join('\n');

function landedWrite(path: string): string | undefined {
  return fake.state.written[path] ?? fake.state.written[path.replace(/^\/+/, '')];
}

describe('ModalProvider writeFileLive content fidelity', () => {
  it('writes a multi-line package.json byte-for-byte, not the printf JSON.stringify payload', async () => {
    const provider = liveProvider();
    await provider.createSandbox();
    await provider.writeFile('package.json', PACKAGE_JSON);

    const landed = landedWrite('/package.json') ?? landedWrite('package.json');
    expect(landed).toBe(PACKAGE_JSON);
    expect(landed).not.toBe(PRINTF_CORRUPT_PACKAGE_JSON);
  });

  it('writes quotes, backslashes, $, backticks, quotes and unicode intact', async () => {
    const provider = liveProvider();
    await provider.createSandbox();
    await provider.writeFile('src/special.ts', SPECIAL_FILE);

    expect(landedWrite('/src/special.ts') ?? landedWrite('src/special.ts')).toBe(SPECIAL_FILE);
  });

  it('preserves a trailing newline and its absence as distinct bytes', async () => {
    const provider = liveProvider();
    await provider.createSandbox();
    await provider.writeFile('with-nl.txt', 'line\n');
    await provider.writeFile('no-nl.txt', 'line');

    expect(landedWrite('/with-nl.txt') ?? landedWrite('with-nl.txt')).toBe('line\n');
    expect(landedWrite('/no-nl.txt') ?? landedWrite('no-nl.txt')).toBe('line');
  });

  it('writes a large generated file without reinterpretation', async () => {
    const provider = liveProvider();
    await provider.createSandbox();
    const large = `${'const x = "`$\'\\\\";\n'.repeat(4000)}// end\n`;
    await provider.writeFile('src/generated.tsx', large);

    expect(landedWrite('/src/generated.tsx') ?? landedWrite('src/generated.tsx')).toBe(large);
  });

  it('writes relative paths as /file, never //file', async () => {
    const provider = liveProvider();
    await provider.createSandbox();
    await provider.writeFile('package.json', PACKAGE_JSON);

    expect(Object.keys(fake.state.written)).toContain('/package.json');
    expect(Object.keys(fake.state.written)).not.toContain('//package.json');
    expect(fake.state.fsWrites.map((write) => write.remotePath)).toEqual(['/package.json']);
  });
});
