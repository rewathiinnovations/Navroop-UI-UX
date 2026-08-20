import { getStack, type StackId } from '@/lib/stacks';

export function buildExportReadme(input: { name: string; stack: string }) {
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

The zip is built from a saved checkpoint of the project. Secrets (\`.env\`), \`node_modules\`, and \`.git\` are omitted.
`;
}
