import { getCoolifyClient } from '@/lib/coolify/client';
import { getSelfIdentity, SELF_UUID_NOT_CONFIGURED } from '@/lib/runtime/self';

export async function restartNavroopApplication() {
  const uuid = getSelfIdentity().coolifyAppUuid;
  if (!uuid) {
    return { ok: false as const, error: SELF_UUID_NOT_CONFIGURED };
  }
  const client = await getCoolifyClient();
  if (!client) {
    return { ok: false as const, error: 'Coolify is not connected' };
  }
  const response = await client.request(`/api/v1/applications/${encodeURIComponent(uuid)}/restart`, {
    method: 'POST',
  });
  if (!response.ok) {
    return { ok: false as const, error: `Coolify restart failed (${response.status})` };
  }
  return { ok: true as const };
}
