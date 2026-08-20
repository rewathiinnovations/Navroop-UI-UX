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

  it('keeps the files after one the model forgot to close', () => {
    // The next opener's own fence used to be read as the unclosed block's close, which
    // left `css{path=…}` behind as body text — so every file after the first was lost.
    const reply = [
      `${fence}tsx{path=src/App.tsx}`,
      'export default function App() {',
      `${fence}css{path=src/index.css}`,
      'body { margin: 0; }',
      fence,
    ].join('\n');
    expect(filesFromReply(reply)).toEqual({
      'src/App.tsx': 'export default function App() {',
      'src/index.css': 'body { margin: 0; }',
    });
    expect(extractCodeBlocks(reply).map((block) => block.truncated)).toEqual([true, false]);
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

  it('parses a reply whose newlines are CRLF', () => {
    // Providers streaming CRLF are not exotic, and the scan matches `\n```' — the `\r`
    // sits at the end of the body, so nothing may depend on the raw body being trimmed.
    const reply = [
      'Here it is.',
      '',
      `${fence}tsx{path=src/App.tsx}`,
      'const a = 1;',
      fence,
      '',
      `${fence}css{path=src/index.css}`,
      'body { margin: 0; }',
      fence,
    ].join('\r\n');
    const files = filesFromReply(reply);
    expect(Object.keys(files)).toEqual(['src/App.tsx', 'src/index.css']);
    expect(files['src/App.tsx'].trim()).toBe('const a = 1;');
    expect(files['src/index.css'].trim()).toBe('body { margin: 0; }');
    expect(files['src/index.css']).not.toContain(fence);
  });

  it('does not turn a pathless fence into a file', () => {
    // F-023: this reply used to come back as { 'file.js': … } — a chatty answer with one
    // illustrative snippet became a persisted project file (visible in the Code tab, the
    // ZIP export and the deploy push), and repeat questions accumulated file-2.js,
    // file-3.js. The prompt contract mandates a path on every fence
    // (lib/stack-prompts/shared.ts: "Never open a bare ```tsx fence"), so a fence with no
    // declared path is prose, not a file.
    const reply = [
      'You can debounce the search input like this:',
      '',
      `${fence}js`,
      'const debounced = debounce(fn, 300);',
      fence,
      '',
      'Let me know if you want me to wire it in.',
    ].join('\n');
    expect(filesFromReply(reply)).toEqual({});
    // The block itself is still scanned — display readers and the truncation walk see it —
    // it just never becomes a file map entry.
    expect(extractCodeBlocks(reply).map((block) => block.declaredPath)).toEqual([false]);
  });
});

describe('explanationFromReply', () => {
  it('returns the prose without the file blocks', () => {
    const reply = `Built a landing page.\n\n${fence}tsx{path=src/App.tsx}\nconst a = 1;\n${fence}\n\nLet me know.`;
    expect(explanationFromReply(reply)).toBe('Built a landing page.\n\nLet me know.');
  });

  it('strips both files when the model forgot a closing fence', () => {
    // The old inline pattern read the second opener's fence as the first block's close,
    // so the second file's code was left sitting in the transcript as prose. Whoever
    // wires chat to this next inherits `extractCodeBlocks`' own scan instead.
    const reply = [
      'Built it.',
      '',
      `${fence}tsx{path=src/App.tsx}`,
      'export default function App() {',
      `${fence}css{path=src/index.css}`,
      'body { margin: 0; }',
      fence,
      '',
      'Let me know.',
    ].join('\n');
    const explanation = explanationFromReply(reply);
    expect(explanation).toBe('Built it.\n\nLet me know.');
    expect(explanation).not.toContain('{path=');
    expect(explanation).not.toContain('margin');
  });
});
