import { hostname } from 'node:os';
import { randomBytes } from 'node:crypto';

/**
 * One instance id per process, shared by every bundle inside it.
 *
 * `abandonInstanceJobs` fences its shutdown drain on `"ownerInstance" = $1` against the id
 * `insertJobRaw` stamped at insert, so those two reads have to agree. A plain module-level
 * constant does not guarantee that: the drain is wired from `instrumentation.ts`, which Next
 * bundles separately from route handlers, so a second evaluation of this module in the same
 * process mints a second id, the fence matches nothing, and the drain settles no jobs at all
 * — silently, because settling zero rows looks exactly like having nothing to settle. The
 * queued reaper window would then be the only recovery for work that was waiting for a
 * provider slot when the process was told to go away.
 *
 * Memoising on `globalThis` is how `lib/db.ts` already keeps the Prisma client a process
 * singleton across bundles, for the same reason. The key is a registry `Symbol` rather than a
 * bare string so nothing else on `globalThis` can collide with it.
 *
 * Deliberately not folded into `lib/runtime/self.ts`: that module is the sole reader of
 * COOLIFY_APP_UUID, which identifies the deployment. This identifies one running process, and
 * two processes of the same deployment must not share it.
 */
const INSTANCE_ID_KEY = Symbol.for('navroop.runtime.instanceId');

type InstanceIdScope = typeof globalThis & { [INSTANCE_ID_KEY]?: string };

export function getInstanceId(): string {
  const scope = globalThis as InstanceIdScope;
  scope[INSTANCE_ID_KEY] ??= `${hostname()}-${process.pid}-${randomBytes(4).toString('hex')}`;
  return scope[INSTANCE_ID_KEY];
}
