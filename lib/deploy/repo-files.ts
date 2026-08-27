import { getStack } from '@/lib/stacks';
import { getStackScaffold } from '@/lib/stacks/templates';

/**
 * The complete file set for a generated project as a standalone repository:
 * the stack scaffold underneath, the generated files on top, plus the files a
 * host needs to build and run it.
 *
 * This is what gets pushed to GitHub and what a Coolify deploy checks out, so
 * it has to stand on its own — a folder of components with no package.json is
 * not a deployable app.
 */

export type RepoFiles = Record<string, string>;

export function buildRepoFiles(
  stack: string,
  generated: Record<string, string>,
  options: {
    projectName?: string;
    /**
     * The project's design direction. Decides the token block in the scaffold's
     * global stylesheet, so a pushed or exported repo carries the same palette
     * the preview showed. Omitted, every export would silently be `minimal`.
     */
    designDirection?: string | null;
  } = {},
): RepoFiles {
  const definition = getStack(stack);
  const files: RepoFiles = {};

  // Scaffold first so a generated file of the same path always wins: the model
  // may legitimately replace the entry point or the Tailwind config.
  for (const file of getStackScaffold(definition.id, options.designDirection)) {
    files[normalize(file.path)] = file.content;
  }
  for (const [path, content] of Object.entries(generated)) {
    files[normalize(path)] = content;
  }

  if (options.projectName) {
    files['package.json'] = withPackageName(files['package.json'], options.projectName);
  }

  files['Dockerfile'] = dockerfileFor(definition.id);
  files['.dockerignore'] = ['node_modules', '.next', 'dist', '.git', '*.log'].join('\n') + '\n';
  files['.gitignore'] =
    ['node_modules', '.next', 'dist', '.env', '.env.local', '*.log'].join('\n') + '\n';
  if (!files['README.md']) {
    files['README.md'] = readmeFor(definition.label, options.projectName);
  }

  return files;
}

function normalize(path: string) {
  return path.replace(/^\.?\//, '').replace(/\\/g, '/');
}

function withPackageName(packageJson: string | undefined, projectName: string) {
  const name = slugify(projectName);
  if (!packageJson) return JSON.stringify({ name, version: '1.0.0', private: true }, null, 2);
  try {
    const parsed = JSON.parse(packageJson) as Record<string, unknown>;
    return JSON.stringify({ ...parsed, name }, null, 2);
  } catch {
    return packageJson;
  }
}

export function slugify(value: string) {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || 'app';
}

/**
 * A Dockerfile rather than leaving it to Nixpacks detection: Coolify builds
 * whatever the repo declares, and an explicit file means the port and start
 * command cannot be guessed wrong.
 */
function dockerfileFor(stack: string) {
  if (stack === 'NEXTJS') {
    return `FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
COPY --from=builder /app ./
EXPOSE 3000
CMD ["npm", "start"]
`;
  }

  if (stack === 'REACT') {
    return `FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .
RUN npm run build

FROM nginx:alpine
COPY --from=builder /app/dist /usr/share/nginx/html
# Single-page app: unknown paths serve index.html instead of 404.
RUN printf 'server {\\n  listen 80;\\n  root /usr/share/nginx/html;\\n  location / {\\n    try_files $uri $uri/ /index.html;\\n  }\\n}\\n' > /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
`;
  }

  return `FROM nginx:alpine
COPY . /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
`;
}

function readmeFor(stackLabel: string, projectName?: string) {
  const title = projectName?.trim() || 'Generated site';
  return `# ${title}

Built with Navroop (${stackLabel}).

## Running locally

\`\`\`bash
npm install
npm run dev
\`\`\`

## Deploying

The repository ships a Dockerfile, so any host that builds from a Dockerfile —
Coolify included — needs no further configuration.
`;
}
