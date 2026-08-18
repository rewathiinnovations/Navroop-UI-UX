import type { CloudflareZone } from './types';

export function chooseCloudflareZone(zones: CloudflareZone[]): {
  status: 'auto' | 'pick' | 'none';
  zone?: CloudflareZone;
  zones?: CloudflareZone[];
} {
  if (zones.length === 0) return { status: 'none' };
  if (zones.length === 1) return { status: 'auto', zone: zones[0] };
  return { status: 'pick', zones };
}

export function cloudflarePermissionMessage(body: {
  errors?: Array<{ code?: number; message?: string }>;
  status?: number;
} | null): string | null {
  const messages = (body?.errors ?? []).map((row) => (row.message || '').toLowerCase());
  const joined = messages.join(' ');
  if (joined.includes('list zones') || joined.includes('zone') && joined.includes('read')) {
    return 'Zone → Zone → Read permission missing';
  }
  if (
    joined.includes('dns') ||
    joined.includes('edit') ||
    joined.includes('permission') ||
    body?.status === 403
  ) {
    return 'Zone → DNS → Edit permission missing';
  }
  return null;
}

export function asCloudflareZones(raw: unknown): CloudflareZone[] {
  const list = Array.isArray(raw) ? raw : [];
  return list
    .map((item) => {
      const row = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
      const account = row.account && typeof row.account === 'object' ? (row.account as Record<string, unknown>) : {};
      const id = typeof row.id === 'string' ? row.id : '';
      const name = typeof row.name === 'string' ? row.name : '';
      if (!id || !name) return null;
      return {
        id,
        name,
        account: { id: typeof account.id === 'string' ? account.id : undefined },
      };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null);
}
