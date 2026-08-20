import type { ScaffoldFile } from './shared';

export function staticHtmlIndex(): string {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <script src="https://cdn.tailwindcss.com"></script>
    <title>New site</title>
  </head>
  <body class="min-h-screen bg-gray-900 text-white flex items-center justify-center p-4">
    <p class="text-lg text-gray-400">Your new static site — edit index.html to get started.</p>
  </body>
</html>`;
}

export function staticHtmlScaffold(): ScaffoldFile[] {
  return [{ path: 'index.html', content: staticHtmlIndex() }];
}
