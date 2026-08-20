import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { appliedPathsFromReply, filesFromReply } from '@/lib/generation/parse-blocks';
import { applyPageCopy } from '@/lib/generation/apply-page-copy';

/**
 * One closing sentence per generation turn, and it is the true one.
 *
 * The workspace used to add two: `sendChatMessage` scanned the reply with
 * /<file path="…">/ for a file list, and the reply is fenced `{path=…}` output,
 * so the list was always empty, the edit branch was unreachable, and every turn
 * closed with a bare "Code generated!" — immediately followed by the real
 * `applyPageCopy` line from `applyGeneratedCode` (F-053). The same mismatch made
 * a retried URL import, which *is* `<file path=…>` XML, close with "Successfully
 * applied 0 files" for a site that had been written in full (F-054).
 */

const WORKSPACE = readFileSync('components/workspace/GenerationWorkspace.tsx', 'utf8');
const ROUTE = readFileSync('app/api/generate-ai-code-stream/route.ts', 'utf8');
const FENCE = '```';

describe('appliedPathsFromReply reads whichever shape it is handed (F-054)', () => {
  it('reads a fenced generation reply', () => {
    const reply = [
      'Here you go.',
      `${FENCE}tsx{path=src/App.tsx}`,
      'export default function App() { return null; }',
      FENCE,
      `${FENCE}css{path=src/index.css}`,
      'body { margin: 0; }',
      FENCE,
    ].join('\n');
    expect(appliedPathsFromReply(reply)).toEqual(['src/App.tsx', 'src/index.css']);
  });

  it('reads the <file path=…> XML a URL import returns', () => {
    const filesXml =
      '<file path="src/App.tsx">export default function App() { return <Hero /> }</file>\n\n' +
      '<file path="src/sections/Hero.tsx">export const Hero = () => null</file>';
    // The parser the generation path uses on its own replies cannot see these,
    // which is what reported "0 files" for a working import.
    expect(Object.keys(filesFromReply(filesXml))).toEqual([]);
    expect(appliedPathsFromReply(filesXml)).toEqual(['src/App.tsx', 'src/sections/Hero.tsx']);
  });

  it('closes a retried import with its real file count', () => {
    const filesXml =
      '<file path="src/App.tsx">a</file>\n<file path="src/sections/Hero.tsx">b</file>';
    expect(applyPageCopy({ filesCreated: appliedPathsFromReply(filesXml) })).toEqual({
      message: 'Successfully applied 2 files',
      warning: null,
    });
    // The regression: the fenced-only reader closed the same import at zero.
    expect(applyPageCopy({ filesCreated: Object.keys(filesFromReply(filesXml)) }).message).toBe(
      'Successfully applied 0 files',
    );
  });

  it('normalizes and dedupes a tagged path the way the fenced reader does', () => {
    const filesXml =
      '<file path="./src/App.tsx">first</file><file path="src/App.tsx">second</file>';
    expect(appliedPathsFromReply(filesXml)).toEqual(['src/App.tsx']);
  });

  it('does not count a <file path=…> tag quoted inside a fenced block', () => {
    const reply = [
      `${FENCE}md{path=docs/format.md}`,
      'Stored files look like <file path="x.tsx">body</file>.',
      FENCE,
    ].join('\n');
    expect(appliedPathsFromReply(reply)).toEqual(['docs/format.md']);
  });

  it('reports nothing for a reply that named no files', () => {
    expect(appliedPathsFromReply('I could not do that.')).toEqual([]);
    expect(appliedPathsFromReply('')).toEqual([]);
  });
});

describe('the workspace closes a turn once (F-053)', () => {
  it('no longer scans the reply for <file path=…> blocks', () => {
    expect(WORKSPACE).not.toMatch(/<file path="\(\[\^"\]\+\)">/);
    expect(WORKSPACE).not.toMatch(/fileRegex/);
    expect(WORKSPACE).not.toMatch(/generatedFiles/);
  });

  it('no longer invents a second success sentence', () => {
    // The literal, not the word: the comment recording why it went still names it.
    expect(WORKSPACE).not.toMatch(/'Code generated!'/);
    expect(WORKSPACE).not.toMatch(/`Updated \$\{editedFileNames\}`/);
  });

  it('still posts the model explanation and still lets applyPageCopy close the turn', () => {
    expect(WORKSPACE).toMatch(/addChatMessage\(explanation, 'ai'/);
    expect(WORKSPACE).toMatch(/applyPageCopy\(\{ filesCreated: appliedFiles \}\)/);
  });

  it('derives the applied file list with the shape-agnostic reader', () => {
    expect(WORKSPACE).toMatch(/const appliedFiles = appliedPathsFromReply\(code\)/);
    expect(WORKSPACE).not.toMatch(/Object\.keys\(filesFromReply\(code\)\)/);
  });
});

describe('the workspace has no invisible log sink (F-058)', () => {
  it('dropped the write-only responseArea state and the log helper', () => {
    expect(WORKSPACE).not.toMatch(/responseArea/);
    expect(WORKSPACE).not.toMatch(/^\s*const log = /m);
  });

  it('reports a failed apply in chat instead of into that sink', () => {
    expect(WORKSPACE).toMatch(/addChatMessage\(`Failed to apply code: /);
  });
});

describe('the stream route has no fake progress interval (F-056)', () => {
  it('dropped the modulus guard that never meant "every 100 characters"', () => {
    expect(ROUTE).not.toMatch(/generatedCode\.length % 100/);
    expect(ROUTE).not.toMatch(/Log every 100 characters streamed/);
  });

  it('still reports the final output size once the stream completes', () => {
    expect(ROUTE).toMatch(/summarizeGenerationOutput\(generatedCode\)/);
  });
});
