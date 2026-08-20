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

/**
 * Cloudflare's code for "this token may not touch that resource": the one refusal that
 * really does mean a permission is missing.
 *
 * Everything else Cloudflare returns on a 4xx — 10000 `Authentication error`, a rate
 * limit, a suspended account, an IP-restricted token, a malformed Authorization header —
 * says nothing about permissions, and `cloudflarePermissionMessage` declines so the caller
 * surfaces Cloudflare's own sentence instead (F-248).
 */
export const CLOUDFLARE_UNAUTHORIZED_CODE = 9109;

/**
 * Which call was refused. Only the caller knows: the same 9109 means "Zone Read" when
 * listing zones and "DNS Edit" when writing a record, and it means neither when all we did
 * was verify the token.
 */
export type CloudflareOperation = 'verify-token' | 'list-zones' | 'edit-dns';

const PERMISSION_ADVICE: Record<CloudflareOperation, string | null> = {
  'verify-token': null,
  'list-zones': 'Zone → Zone → Read permission missing',
  'edit-dns': 'Zone → DNS → Edit permission missing',
};

/**
 * The permission to add, or `null` when Cloudflare's refusal was not about permissions.
 *
 * It used to infer the permission from substrings of the error text and, failing that,
 * from a bare `status === 403` — so every 403 on the write probe read as "add DNS Edit"
 * even when the real cause was a rate limit or a suspended account.
 */
export function cloudflarePermissionMessage(
  body: {
    errors?: Array<{ code?: number; message?: string }>;
    status?: number;
  } | null,
  operation: CloudflareOperation,
): string | null {
  const unauthorized = (body?.errors ?? []).some(
    (row) => row.code === CLOUDFLARE_UNAUTHORIZED_CODE,
  );
  if (!unauthorized) return null;
  return PERMISSION_ADVICE[operation];
}

export function asCloudflareZones(raw: unknown): CloudflareZone[] {
  const list = Array.isArray(raw) ? raw : [];
  return list
    .map((item) => {
      const row = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
      const account =
        row.account && typeof row.account === 'object'
          ? (row.account as Record<string, unknown>)
          : {};
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
