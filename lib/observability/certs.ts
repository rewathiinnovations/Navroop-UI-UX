import tls from 'node:tls';
import { appPublicUrl } from '../settings/app-url';

export async function checkSiteCertificate(
  deps: { url?: string; connect?: typeof tls.connect } = {},
) {
  // The address an operator edits in /admin/config, not the build-time environment variable.
  // This read `process.env.APP_URL` directly, so changing Application URL flipped the badge on
  // the settings page and left the certificate check watching the old host until a redeploy.
  const raw = deps.url ?? (await appPublicUrl());
  let host: string;
  let port = 443;
  try {
    const parsed = new URL(raw);
    host = parsed.hostname;
    port = parsed.port ? Number(parsed.port) : parsed.protocol === 'http:' ? 80 : 443;
  } catch {
    // `appPublicUrl` always returns a value and falls back to localhost, so an unset
    // Application URL now lands on the non-TLS skip below rather than here. This branch is for
    // a saved setting that is not a URL at all, which is operator input and must say so.
    return { ok: false, detail: `the configured application URL is not a valid URL: ${raw}` };
  }
  if (port !== 443) {
    return { ok: true, detail: `non-TLS port ${port} — certificate check skipped` };
  }

  const connect = deps.connect ?? tls.connect;
  const expiresAt = await new Promise<Date>((resolve, reject) => {
    const socket = connect({ host, port, servername: host, timeout: 10_000 }, () => {
      const cert = socket.getPeerCertificate();
      socket.end();
      if (!cert || !('valid_to' in cert) || !cert.valid_to) {
        reject(new Error('no peer certificate'));
        return;
      }
      resolve(new Date(cert.valid_to));
    });
    socket.on('error', (error) => {
      socket.destroy();
      reject(error);
    });
    socket.on('timeout', () => {
      socket.destroy();
      reject(new Error('certificate check timed out'));
    });
  });

  const remainingMs = expiresAt.getTime() - Date.now();
  if (remainingMs < 14 * 24 * 60 * 60 * 1000) {
    return { ok: false, detail: `certificate expires ${expiresAt.toISOString()}` };
  }
  return { ok: true, detail: `certificate valid until ${expiresAt.toISOString()}` };
}
