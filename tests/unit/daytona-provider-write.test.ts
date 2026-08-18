import { describe, expect, it, vi } from 'vitest';
import { base64DecodeWriteCommand } from '@/lib/sandbox/providers/shell-file-write';

/**
 * Daytona's live path prefers `fs.uploadFile(Buffer, path)` (byte-safe).
 * The shell fallback used to be the same `printf %s ${JSON.stringify}` bug
 * as Modal. Mocked SDK — no live VM.
 */

const PACKAGE_JSON = '{\n  "name": "sandbox-app",\n  "private": true\n}\n';

const fake = vi.hoisted(() => {
  const state: {
    uploads: Array<{ dest: string; bytes: string }>;
    commands: string[];
    hasUpload: boolean;
  } = {
    uploads: [],
    commands: [],
    hasUpload: true,
  };
  return {
    state,
    reset() {
      state.uploads = [];
      state.commands = [];
      state.hasUpload = true;
    },
    sandbox: {
      id: 'sb-daytona-write-1',
      process: {
        async executeCommand(command: string) {
          fake.state.commands.push(command);
          return { result: '', exitCode: 0 };
        },
      },
      get fs() {
        if (!state.hasUpload) return {};
        return {
          async uploadFile(src: Buffer, dest: string) {
            state.uploads.push({ dest, bytes: src.toString('utf8') });
          },
          async downloadFile() {
            return Buffer.from('');
          },
        };
      },
      async getPreviewLink() {
        return { url: 'https://preview.daytona.test' };
      },
      async delete() {},
    },
  };
});

vi.mock('@daytona/sdk', () => ({
  Daytona: class Daytona {
    constructor(_opts: { apiKey: string }) {}
    async create() {
      return fake.sandbox;
    }
  },
}));

const { DaytonaProvider } = await import('@/lib/sandbox/providers/daytona-provider');

describe('DaytonaProvider writeFileLive', () => {
  it('uploads the original bytes when fs.uploadFile exists', async () => {
    fake.reset();
    const provider = new DaytonaProvider({ apiKey: 'not-a-real-key' });
    await provider.createSandbox();
    await provider.writeFile('package.json', PACKAGE_JSON);

    expect(fake.state.uploads).toEqual([{ dest: 'package.json', bytes: PACKAGE_JSON }]);
    expect(fake.state.commands).toEqual([]);
  });

  it('falls back to a base64 decode write, not printf JSON.stringify', async () => {
    fake.reset();
    fake.state.hasUpload = false;
    const provider = new DaytonaProvider({ apiKey: 'not-a-real-key' });
    await provider.createSandbox();
    await provider.writeFile('package.json', PACKAGE_JSON);

    expect(fake.state.uploads).toEqual([]);
    expect(fake.state.commands).toEqual([base64DecodeWriteCommand('package.json', PACKAGE_JSON)]);
    expect(fake.state.commands[0]).not.toContain('{\\n  "name": "sandbox-app"');
  });
});
