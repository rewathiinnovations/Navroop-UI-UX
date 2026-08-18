/**
 * Modal's `filesystem.writeText` / `readText` require an absolute path.
 * Relative `package.json` from cwd `/` is what npm printed as `//package.json`.
 * Container-root files (`package.json` → `/package.json`) stay where
 * `setupViteApp` already runs `npm install` and the Vite/Next server.
 */
export function absoluteSandboxPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed || trimmed === '.') return '/';
  const withRoot = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return withRoot.replace(/\/{2,}/g, '/');
}
