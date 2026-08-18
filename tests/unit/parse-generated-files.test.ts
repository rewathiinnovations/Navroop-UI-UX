import { describe, expect, it } from 'vitest';
import { parseGeneratedFilesLenient } from '@/lib/generation/parse-files';

describe('parseGeneratedFiles', () => {
  it('parses well-formed file blocks', () => {
    const files = parseGeneratedFilesLenient(
      '<file path="src/App.jsx">export default function App() {}</file>\n' +
        '<file path="src/index.css">body {}</file>',
    );
    expect(files).toEqual([
      { path: 'src/App.jsx', content: 'export default function App() {}', closed: true },
      { path: 'src/index.css', content: 'body {}', closed: true },
    ]);
  });

  it('treats a new opener as the close of the previous block', () => {
    // The live REACT build: three files streamed, zero </file> tags, and the
    // strict parser returned nothing — the whole site was discarded.
    const files = parseGeneratedFilesLenient(
      'NEED_IMAGE: hero shot\n' +
        '<file path="src/App.jsx">\n```jsx\nconst a = 1;\n```\n' +
        '<file path="src/components/Hero.jsx">\n```jsx\nconst b = 2;\n```\n',
    );
    expect(files.map((f) => f.path)).toEqual(['src/App.jsx', 'src/components/Hero.jsx']);
    expect(files[0].content).toBe('const a = 1;');
    expect(files[0].closed).toBe(false);
    expect(files[1].content).toBe('const b = 2;');
    expect(files[1].closed).toBe(false);
  });

  it('unwraps a single wrapping markdown fence but keeps inner fences', () => {
    const files = parseGeneratedFilesLenient(
      '<file path="README.md">```md\n# Title\n\n```js\ncode\n```\n```</file>',
    );
    expect(files[0].content).toBe('# Title\n\n```js\ncode\n```');
  });

  it('keeps the last occurrence when a path repeats', () => {
    const files = parseGeneratedFilesLenient(
      '<file path="a.txt">one</file><file path="a.txt">two</file>',
    );
    expect(files).toEqual([{ path: 'a.txt', content: 'two', closed: true }]);
  });

  it('drops empty blocks', () => {
    expect(parseGeneratedFilesLenient('<file path="a.txt"></file>')).toEqual([]);
  });
});
