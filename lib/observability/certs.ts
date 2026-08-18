import tls from 'node:tls';

export async function checkSiteCertificate(deps: { url?: string; connect?: typeof tls.connect } = {}) {
  const raw = deps.url ?? process.env.APP_URL ?? process.env.NEXTAUTH_URL ?? '';
  if (!raw) {
    return { ok: true, detail: 'APP_URL not set — certificate check skipped' };
  }
  let host: string;
  let port = 443;
  try {
    const parsed = new URL(raw);
    host = parsed.hostname;
    port = parsed.port ? Number(parsed.port) : parsed.protocol === 'http:' ? 80 : 443;
  } catch {
    return { ok: false, detail: 'APP_URL is not a valid URL' };
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
