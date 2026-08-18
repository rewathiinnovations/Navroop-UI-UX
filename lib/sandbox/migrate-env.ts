import { randomUUID } from 'crypto';
import { log } from '@/lib/logger';
import { getSetting } from '@/lib/settings/resolve';
import { encryptProviderSecrets, insertProviderConfig, listProviderConfigs } from './store';

let ran = false;

/** First boot: if no provider rows and an E2B key is configured, migrate it. After that the setting is ignored here. */
export async function migrateEnvSandboxProvider() {
  if (ran) return;
  ran = true;
  try {
    const existing = await listProviderConfigs();
    if (existing.length > 0) {
      if (await getSetting('tooling.e2b.apiKey')) {
        log.info('sandbox.env_ignored', {
          message: 'E2B_API_KEY is ignored because SandboxProviderConfig rows already exist',
        });
      }
      return;
    }
    const apiKey = await getSetting('tooling.e2b.apiKey');
    if (!apiKey) return;
    await insertProviderConfig({
      id: randomUUID(),
      name: 'E2B (migrated)',
      driver: 'e2b',
      secrets: encryptProviderSecrets({ apiKey }),
      creditType: 'one_time',
      creditTotalUsd: null,
      creditRemainingUsd: null,
      priority: 100,
    });
    log.info('sandbox.env_migrated', {
      message: 'Created E2B (migrated) from E2B_API_KEY. The env var is now ignored.',
    });
  } catch (error) {
    log.warn('sandbox.env_migrate_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
