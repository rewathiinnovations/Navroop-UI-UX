import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  NO_PROJECT_FILES_NOTICE,
  SANDBOX_READ_FAILED_NOTICE,
  shouldRetrySandboxFileRead,
} from '../../lib/generation/sandbox-read-notices';

const routePath = path.join(
  fileURLToPath(new URL('../../', import.meta.url)),
  'app/api/generate-ai-code-stream/route.ts',
);

function generateRouteSource() {
  return readFileSync(routePath, 'utf8');
}

function secondSandboxReadBlock(source: string) {
  const start = source.indexOf('If no backend files and we\'re in edit mode, try to fetch from sandbox');
  const end = source.indexOf('Include current file contents from backend cache');
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('sandbox-read notices — one fact per chat line', () => {
  it('does not retry a leftover sandboxId when no workspace is running', () => {
    expect(
      shouldRetrySandboxFileRead({
        hasBackendFiles: false,
        isEdit: true,
        hasActiveSandbox: false,
      }),
    ).toBe(false);
    expect(
      shouldRetrySandboxFileRead({
        hasBackendFiles: false,
        isEdit: true,
        hasActiveSandbox: true,
      }),
    ).toBe(true);
  });

  it('wires the generate route to that decision instead of ORing context.sandboxId', () => {
    const source = generateRouteSource();
    const secondBlock = secondSandboxReadBlock(source);

    expect(source).toMatch(/shouldRetrySandboxFileRead\(/);
    expect(secondBlock).toMatch(/shouldRetrySandboxFileRead\(/);
    const condition = secondBlock.slice(0, secondBlock.indexOf('No backend files, attempting to fetch'));
    expect(condition).toMatch(/hasActiveSandbox:\s*Boolean\(global\.activeSandbox\)/);
    expect(condition).not.toMatch(/context\?\.sandboxId/);
    expect(secondBlock).toMatch(/SANDBOX_READ_FAILED_NOTICE/);
  });

  it('keeps the no-files sentence and the live-sandbox read failure distinct', () => {
    expect(NO_PROJECT_FILES_NOTICE).toMatch(/could not find any files/i);
    expect(NO_PROJECT_FILES_NOTICE).toMatch(/Open the project preview/i);
    expect(SANDBOX_READ_FAILED_NOTICE).toMatch(/Could not read the current files/i);
    expect(SANDBOX_READ_FAILED_NOTICE).toMatch(/general edit mode/i);
    expect(SANDBOX_READ_FAILED_NOTICE).not.toBe(NO_PROJECT_FILES_NOTICE);
    expect(SANDBOX_READ_FAILED_NOTICE).not.toMatch(/build failed/i);
    expect(NO_PROJECT_FILES_NOTICE).not.toMatch(/build failed/i);
  });

  it('does not collapse the no-changes conversation+error pair', () => {
    const source = generateRouteSource();
    expect(source).toMatch(/Do not collapse this pair the way the/);
    expect(source).toMatch(/await sendProgress\(\{ type: 'conversation', text: noChangeReason \}\)/);
    expect(source).toMatch(/await sendProgress\(\{ type: 'error', error: noChangeReason \}\)/);
  });
});
