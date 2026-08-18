/**
 * Who this running instance is.
 *
 * `COOLIFY_APP_UUID` is the app's own identity — "which Coolify application am
 * I" — not a credential for an integration, so it stays in the environment
 * rather than the Integration store. Restart and rollback both act on this
 * instance, and both used to read the variable themselves; a typo in one place
 * was only discovered when a rollback failed. It is read once here instead.
 */
import { currentRelease } from '@/lib/deploy/release';
import { getInstanceId } from './instance';

export type SelfIdentity = {
  /** Coolify application UUID for this app. Null when it is not configured. */
  coolifyAppUuid: string | null;
  /** Deployed commit, or 'unknown' outside a built image. */
  gitSha: string;
  /** Unique per process. Used to own jobs and heartbeats. */
  instanceId: string;
  environment: string;
};

/** The one English string both restart and rollback show when the UUID is absent. */
export const SELF_UUID_NOT_CONFIGURED =
  'COOLIFY_APP_UUID is not configured on this instance, so Navroop cannot identify its own Coolify application. Set it in the deployment environment and restart.';

let cached: SelfIdentity | null = null;

function read(env: NodeJS.ProcessEnv): SelfIdentity {
  const uuid = (env.COOLIFY_APP_UUID || '').trim();
  return {
    // A blank or whitespace-only value is the same as unset: treating it as a
    // UUID produces a Coolify 404 that reads like an outage.
    coolifyAppUuid: uuid.length > 0 ? uuid : null,
    gitSha: currentRelease(env).sha,
    instanceId: getInstanceId(),
    environment: env.NODE_ENV || 'development',
  };
}

/**
 * Pass `env` only in tests. Doing so bypasses the cache so a test can vary the
 * environment without leaking state into the next test.
 */
export function getSelfIdentity(env?: NodeJS.ProcessEnv): SelfIdentity {
  if (env) return read(env);
  if (!cached) cached = read(process.env);
  return cached;
}

export function resetSelfIdentityCache() {
  cached = null;
}
