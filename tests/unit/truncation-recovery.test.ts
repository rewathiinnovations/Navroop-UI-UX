import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { bindStreamErrorCapture } from '../../lib/ai/empty-completion';
import { jobErrorCodeForProviderFailure, providerFailureMessage } from '../../lib/ai/failover';
import {
  TRUNCATION_INCOMPLETE_KEPT,
  collectRecoveredStreamText,
  detectTruncatedFiles,
  truncationRecoveryFailureMessage,
  truncationRecoveryOutcome,
} from '../../lib/generation/truncation-recovery';
import { filesFromReply, replaceBlockInReply } from '../../lib/generation/parse-blocks';

const FENCE = '```';

function unregisteredCallerError() {
  const error = new Error(
    "Method doesn't allow unregistered callers (callers without established identity). Please use API Key or other form of API consumer identity to call this API.",
  ) as Error & { statusCode: number };
  error.name = 'AI_APICallError';
  error.statusCode = 403;
  return error;
}

const GEMINI_KEY_REJECTED =
  'DeepSeek rejected the API key. Ask an administrator to check the DeepSeek key, then try again.';

const routePath = path.join(
  fileURLToPath(new URL('../../', import.meta.url)),
  'app/api/generate-ai-code-stream/route.ts',
);

function recoveryBlock() {
  const source = readFileSync(routePath, 'utf8');
  const start = source.indexOf('Attempting to regenerate truncated files');
  // The statement after the recovery block. It used to slice to
  // "message: 'Truncation recovery complete'" — a string the route no longer contains, so
  // the slice silently ran to the end of the file and every assertion below was really
  // being made against the whole route.
  const end = source.indexOf('const usageProjectId =', start);
  return source.slice(start, end === -1 ? source.length : end);
}

describe('truncation-recovery streamText must not swallow a rejected call', () => {
  it('collectRecoveredStreamText throws the captured AI_APICallError instead of returning empty text', async () => {
    const apiError = unregisteredCallerError();
    const capture = bindStreamErrorCapture();
    const result = capture.attach({
      textStream: (async function* () {
        capture.onError({ error: apiError });
      })(),
      text: Promise.resolve(''),
    });

    await expect(collectRecoveredStreamText(result)).rejects.toBe(apiError);
    expect(jobErrorCodeForProviderFailure(apiError)).toBe('provider_not_configured');
    expect(jobErrorCodeForProviderFailure(apiError)).not.toBe('no_files_generated');
  });

  it('a failed recovery after truncation keeps the files and names the classified cause', () => {
    const apiError = unregisteredCallerError();
    const outcome = truncationRecoveryOutcome(apiError, 'google');

    expect(outcome.keepTruncatedFiles).toBe(true);
    expect(outcome.complete).toBe(false);
    expect(outcome.errorCode).toBe('provider_not_configured');
    expect(outcome.errorMessage).toBe(`${TRUNCATION_INCOMPLETE_KEPT} ${GEMINI_KEY_REJECTED}`);
    expect(outcome.errorMessage).toBe(truncationRecoveryFailureMessage(apiError, 'google'));
    expect(outcome.errorMessage).toMatch(/incomplete/i);
    expect(outcome.errorMessage).toMatch(/truncated files were kept/i);
    expect(providerFailureMessage(apiError, 'google')).toBe(GEMINI_KEY_REJECTED);
  });

  it('the generate route recovery streamText binds onError the same way as the main path', () => {
    const block = recoveryBlock();
    expect(block).toMatch(/bindStreamErrorCapture\(/);
    expect(block).toMatch(/onError:\s*capture\.onError/);
    expect(block).toMatch(/collectRecoveredStreamText\(/);
    expect(block).toMatch(/truncationRecoveryOutcome\(/);
    expect(block).not.toMatch(/Truncation recovery complete/);
  });
});

/**
 * Detection used to scan for `<file path="…">` tags, which the prompt never asks for, so
 * `truncationWarnings` was always empty on real output: recovery was unreachable and a
 * reply cut off mid-file shipped as a finished build. These cases are the fenced contract
 * `COMPLETION_RULES` actually specifies.
 */
describe('truncation detection reads the fenced {path=...} contract', () => {
  it('fires on a fenced block the reply stopped inside', () => {
    const reply = [
      'Here is the app.',
      '',
      `${FENCE}tsx{path=src/App.tsx}`,
      "import { Hero } from './Hero';",
      'export default function App() {',
      '  return (',
    ].join('\n');

    const truncated = detectTruncatedFiles(reply);

    expect(truncated.map((file) => file.path)).toEqual(['src/App.tsx']);
    expect(truncated[0].warning).toMatch(/cut off/i);
  });

  it('stays quiet on a complete reply', () => {
    const reply = [
      'Built it.',
      '',
      `${FENCE}tsx{path=src/App.tsx}`,
      'export default function App() { return null; }',
      FENCE,
      '',
      `${FENCE}css{path=src/index.css}`,
      'body { margin: 0; }',
      FENCE,
    ].join('\n');

    expect(detectTruncatedFiles(reply)).toEqual([]);
  });

  it('does not spend a recovery call on a finished file that merely lost its closing fence', () => {
    const reply = [
      `${FENCE}tsx{path=src/App.tsx}`,
      'export default function App() { return null; }',
    ].join('\n');

    expect(detectTruncatedFiles(reply)).toEqual([]);
  });

  it('ignores an unnamed prose snippet, which recovery could not re-ask for', () => {
    const reply = [`${FENCE}bash`, 'npm install (', ''].join('\n');

    expect(detectTruncatedFiles(reply)).toEqual([]);
  });

  it('flags a script whose braces are severely unmatched', () => {
    const reply = [
      `${FENCE}tsx{path=src/Broken.tsx}`,
      'export function Broken() { if (a) { if (b) { if (c) { return <p>x</p>;',
      FENCE,
    ].join('\n');

    expect(detectTruncatedFiles(reply).map((file) => file.path)).toEqual(['src/Broken.tsx']);
  });

  it('puts a repaired file back in a shape filesFromReply parses', () => {
    const reply = [
      'Working on it.',
      '',
      `${FENCE}tsx{path=src/App.tsx}`,
      'export default function App() {',
      '',
      `${FENCE}css{path=src/index.css}`,
      'body { margin: 0; }',
      FENCE,
    ].join('\n');

    const repaired = replaceBlockInReply(
      reply,
      'src/App.tsx',
      'export default function App() { return null; }',
    );

    expect(repaired).not.toBeNull();
    expect(filesFromReply(repaired ?? '')).toEqual({
      'src/App.tsx': 'export default function App() { return null; }',
      'src/index.css': 'body { margin: 0; }',
    });
    // The repair has to clear the warning it was made for, or the run reports incomplete.
    expect(detectTruncatedFiles(repaired ?? '')).toEqual([]);
    expect(repaired).not.toContain('<file path=');
  });

  it('reports a miss instead of silently dropping the completed file', () => {
    const reply = `${FENCE}tsx{path=src/App.tsx}\nconst a = 1;\n${FENCE}`;

    expect(replaceBlockInReply(reply, 'src/Missing.tsx', 'const b = 2;')).toBeNull();
  });

  /**
   * Every case here is a *correct* file. A false positive is not free: it spends a second
   * model call and then overwrites the file with whatever the recovery model invents for
   * "Complete the following file that was truncated". The tiny-file branch used to fire on
   * all of the first three, because it asked only "short and no `export`" and never asked
   * whether the block showed any sign of being cut off.
   */
  it('does not flag a legitimately tiny file that is finished', () => {
    const reply = [
      `${FENCE}ts{path=src/vite-env.d.ts}`,
      '/// <reference types="vite/client" />',
      FENCE,
      '',
      `${FENCE}ts{path=src/setupTests.ts}`,
      "import '@testing-library/jest-dom';",
      FENCE,
      '',
      `${FENCE}ts{path=src/types/global.d.ts}`,
      'declare module "*.svg";',
      FENCE,
    ].join('\n');

    expect(detectTruncatedFiles(reply)).toEqual([]);
  });

  it('does not flag a brace-heavy config, minified output, or JSON', () => {
    const reply = [
      `${FENCE}js{path=tailwind.config.js}`,
      'module.exports = {',
      "  content: ['./src/**/*.{js,ts,jsx,tsx}'],",
      '  theme: { extend: { colors: { brand: { 500: "#6d28d9" } }, spacing: { 18: "4.5rem" } } },',
      '  plugins: [],',
      '};',
      FENCE,
      '',
      `${FENCE}js{path=src/vendor.min.js}`,
      '!function(e,t){"object"==typeof exports?t(exports):t(e.lib={})}(this,function(e){e.x=function(t){return t+1}});',
      FENCE,
      '',
      `${FENCE}json{path=package.json}`,
      '{ "name": "site", "private": true }',
      FENCE,
    ].join('\n');

    expect(detectTruncatedFiles(reply)).toEqual([]);
  });

  it('does not read a typographic ellipsis in copy as a cut-off file', () => {
    // The check is ASCII `...`; "Loading…" is U+2026 and must never match.
    const reply = [
      `${FENCE}tsx{path=src/Loading.tsx}`,
      'export function Loading() { return <p>Loading\u2026</p>; }',
      FENCE,
    ].join('\n');

    expect(detectTruncatedFiles(reply)).toEqual([]);
  });

  it('names a ./-prefixed truncated file by the key the repair matches on', () => {
    // `detectTruncatedFiles` used to hand back the raw declared path. `replaceBlockInReply`
    // strips `./` from the block but not from the target, so the repair this second model
    // call was paid for matched nothing, the route threw, and the user was told their build
    // was incomplete under a `provider_error` code — for a local spelling mismatch.
    const reply = [
      `${FENCE}tsx{path=./src/App.tsx}`,
      'export default function App() {',
      '  return (',
    ].join('\n');

    const truncated = detectTruncatedFiles(reply);
    expect(truncated.map((file) => file.path)).toEqual(['src/App.tsx']);

    const repaired = replaceBlockInReply(
      reply,
      truncated[0].path,
      'export default function App() { return null; }',
    );
    expect(repaired).not.toBeNull();
    expect(filesFromReply(repaired ?? '')).toEqual({
      'src/App.tsx': 'export default function App() { return null; }',
    });
    expect(detectTruncatedFiles(repaired ?? '')).toEqual([]);
  });

  it('repairs the second block claiming one path, under the deduplicated key', () => {
    const reply = [
      `${FENCE}tsx{path=src/App.tsx}`,
      'const a = 1;',
      FENCE,
      `${FENCE}tsx{path=src/App.tsx}`,
      'export default function App() {',
      '  return (',
    ].join('\n');

    const truncated = detectTruncatedFiles(reply);
    expect(truncated.map((file) => file.path)).toEqual(['src/App-2.tsx']);

    const repaired = replaceBlockInReply(reply, truncated[0].path, 'const b = 2;');
    expect(repaired).not.toBeNull();
    // The first block is untouched: the repair landed on the block detection named.
    expect(filesFromReply(repaired ?? '')).toEqual({
      'src/App.tsx': 'const a = 1;',
      'src/App-2.tsx': 'const b = 2;',
    });
  });

  it('the route keeps what was generated on a miss instead of throwing out of the run', () => {
    const block = recoveryBlock();
    // A miss is a local path-matching bug, not a provider outage. Throwing here landed in
    // the catch below, which classified it as `provider_error`, abandoned every remaining
    // truncated file untried, and reported a repairable build as incomplete.
    expect(block).not.toMatch(/throw new Error\(\s*`Could not find/);
    expect(block).toMatch(/if \(!repaired\) \{/);
    expect(block).toMatch(/unrepairedWarnings\.push\(truncatedFile\.warning\);\s*\n\s*continue;/);
    // The user is told which files were not repaired rather than that the build failed.
    expect(block).toMatch(/Could not repair \$\{unrepairedWarnings\.length\}/);
  });
});
