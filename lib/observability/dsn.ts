export type ParsedSentryDsn = {
  projectId: string;
  host: string;
  protocol: string;
};

export function parseSentryDsn(dsn: string): ParsedSentryDsn | null {
  const value = String(dsn || '').trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    const projectId = url.pathname.replace(/^\//, '').split('/')[0] || '';
    if (!url.username || !projectId) return null;
    if (!/^https?:$/.test(url.protocol)) return null;
    return { projectId, host: url.host, protocol: url.protocol.replace(':', '') };
  } catch {
    return null;
  }
}

export function dsnProjectId(dsn: string) {
  return parseSentryDsn(dsn)?.projectId ?? null;
}
