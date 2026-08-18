import { describe, expect, it } from 'vitest';
import {
  explanationFromReply,
  extractCodeBlocks,
  filesFromReply,
  normalizeFenceOpeners,
  stripThinkingBlocks,
} from '@/lib/generation/parse-blocks';

const fence = '```';

describe('extractCodeBlocks', () => {
  it('reads the path from the fence header', () => {
    const reply = [
      "Here's the app.",
      `${fence}tsx{path=src/App.tsx}`,
      'export default function App() { return null; }',
      fence,
      `${fence}css{path=src/index.css}`,
      'body { margin: 0; }',
      fence,
    ].join('\n');
    expect(filesFromReply(reply)).toEqual({
      'src/App.tsx': 'export default function App() { return null; }',
      'src/index.css': 'body { margin: 0; }',
    });
  });

  it('accepts the path attribute on the line after the opener', () => {
    const reply = [
      `${fence}tsx`,
      '{path=src/Card.tsx}',
      'export const Card = () => null;',
      fence,
    ].join('\n');
    expect(filesFromReply(reply)).toEqual({ 'src/Card.tsx': 'export const Card = () => null;' });
  });

  it('recovers a fence glued to the end of a prose line', () => {
    // Models do this constantly; unnormalized, the file is silently dropped.
    const reply = `Now the types.${fence}ts{path=src/types.ts}\nexport type A = 1;\n${fence}`;
    expect(filesFromReply(reply)).toEqual({ 'src/types.ts': 'export type A = 1;' });
  });

  it('drops an orphan closing brace split onto the first code line', () => {
    const reply = [`${fence}ts{path=src/data.ts`, '}', 'export const data = [];', fence].join('\n');
    expect(filesFromReply(reply)).toEqual({ 'src/data.ts': 'export const data = [];' });
  });

  it('keeps a file whose closing fence never arrived', () => {
    const reply = [`${fence}tsx{path=src/App.tsx}`, 'export default function App() {'].join('\n');
    expect(filesFromReply(reply)).toEqual({ 'src/App.tsx': 'export default function App() {' });
  });

  it('never collapses two blocks that claim the same path', () => {
    const reply = [
      `${fence}tsx{path=src/App.tsx}`,
      'const a = 1;',
      fence,
      `${fence}tsx{path=src/App.tsx}`,
      'const b = 2;',
      fence,
    ].join('\n');
    expect(extractCodeBlocks(reply).map((block) => block.path)).toEqual([
      'src/App.tsx',
      'src/App-2.tsx',
    ]);
  });

  it('strips thinking blocks before parsing', () => {
    expect(stripThinkingBlocks('<think>plan</think>done')).toBe('done');
    const reply = `<thinking>weighing options</thinking>\n${fence}tsx{path=src/App.tsx}\nconst a = 1;\n${fence}`;
    expect(filesFromReply(reply)).toEqual({ 'src/App.tsx': 'const a = 1;' });
  });

  it('normalizes only path-tagged openers', () => {
    const inline = `text ${fence}js\ncode\n${fence}`;
    expect(normalizeFenceOpeners(inline)).toBe(inline);
  });

  it('strips a leading ./ from declared paths', () => {
    const reply = `${fence}tsx{path=./src/App.tsx}\nconst a = 1;\n${fence}`;
    expect(Object.keys(filesFromReply(reply))).toEqual(['src/App.tsx']);
  });
});

describe('explanationFromReply', () => {
  it('returns the prose without the file blocks', () => {
    const reply = `Built a landing page.\n\n${fence}tsx{path=src/App.tsx}\nconst a = 1;\n${fence}\n\nLet me know.`;
    expect(explanationFromReply(reply)).toBe('Built a landing page.\n\nLet me know.');
  });
});
