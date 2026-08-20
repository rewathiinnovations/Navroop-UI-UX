'use client';

import { PrismLight as SyntaxHighlighter } from 'react-syntax-highlighter';
import css from 'react-syntax-highlighter/dist/esm/languages/prism/css';
import json from 'react-syntax-highlighter/dist/esm/languages/prism/json';
import jsx from 'react-syntax-highlighter/dist/esm/languages/prism/jsx';
import markup from 'react-syntax-highlighter/dist/esm/languages/prism/markup';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';

/**
 * Syntax highlighting for the streaming code panel, in its own chunk.
 *
 * `StreamingCodePanel` used to import `Prism` from the package root, which pulls
 * *every* refractor grammar and the full theme set — the ~1 MB variant — into the
 * workspace route's first client chunk, for every user, on every load (F-639).
 *
 * Two changes: `PrismLight` with only the four languages `codeLanguage` can
 * actually return, and this module is reached through `next/dynamic`, so it is
 * fetched when code first needs highlighting rather than on workspace mount.
 */

SyntaxHighlighter.registerLanguage('jsx', jsx);
SyntaxHighlighter.registerLanguage('css', css);
SyntaxHighlighter.registerLanguage('json', json);
// Prism calls HTML "markup"; the panel asks for `html`, so register both names.
SyntaxHighlighter.registerLanguage('markup', markup);
SyntaxHighlighter.registerLanguage('html', markup);

export default function StreamedCodeBlock({ language, code }: { language: string; code: string }) {
  return (
    <SyntaxHighlighter
      language={language}
      style={vscDarkPlus}
      customStyle={{
        margin: 0,
        padding: '1rem',
        fontSize: '0.875rem',
        background: 'transparent',
      }}
      showLineNumbers
    >
      {code}
    </SyntaxHighlighter>
  );
}
