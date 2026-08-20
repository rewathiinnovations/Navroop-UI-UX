import { getStack, type StackId } from '@/lib/stacks';
import { EXPORT_MAX_FILE_BYTES, type OversizedExportFile } from './files';

function omissions(oversized: readonly OversizedExportFile[]) {
  const limitMb = Math.round(EXPORT_MAX_FILE_BYTES / (1024 * 1024));
  const structural = `Secrets (\`.env\`), \`node_modules\`, and \`.git\` are omitted.`;
  if (oversized.length === 0) return structural;
  const rows = oversized
    .map((file) => `- \`${file.path}\` (${(file.bytes / (1024 * 1024)).toFixed(1)} MB)`)
    .join('\n');
  // F-796: these used to vanish from the archive with nothing said anywhere. A download that
  // is missing a file the user wrote has to name it, or the omission is discovered at build
  // time in a folder the user assumes is complete.
  return `${structural}

### Files left out because they are over ${limitMb} MB

${rows}

Copy these from the project in Navroop if you need them.`;
}

export function buildExportReadme(input: {
  name: string;
  stack: string;
  oversized?: readonly OversizedExportFile[];
}) {
  const stack = getStack(input.stack);
  const install = stack.installCommand || 'This stack has no package install step.';
  const build = stack.buildCommand || 'This stack has no production build command.';
  const start = stack.startCommand ? `\nStart: \`${stack.startCommand}\`` : '';

  return `# ${input.name}

Exported from Navroop.

## Stack

${stack.label} (\`${stack.id as StackId}\`)

## Run locally

1. Unzip this archive and open the folder in a terminal.
2. Install dependencies: \`${install}\`
3. Start the dev server: \`${stack.devCommand}\`
4. Production build: \`${build}\`${start}

## What is in the zip

The zip is built from a saved checkpoint of the project. ${omissions(input.oversized ?? [])}
`;
}
