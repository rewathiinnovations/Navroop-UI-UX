/** Hosts the sandbox preview is served from. */
export const SANDBOX_ALLOWED_HOSTS = [
  '.e2b.app',
  '.e2b.dev',
  '.vercel.run',
  'localhost',
  '127.0.0.1',
] as const;

export const VITE_SERVER_BLOCK = `  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    hmr: false,
    allowedHosts: ${JSON.stringify([...SANDBOX_ALLOWED_HOSTS])}
  }`;

export type ScaffoldFile = {
  path: string;
  content: string;
};
