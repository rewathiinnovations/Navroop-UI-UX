import { NextResponse } from 'next/server';
import type { AcquireFail, LockLost } from './lock';

export function lockHeldMessage(name: string) {
  return `${name} is working on this project`;
}

export function lockConflictBody(result: AcquireFail) {
  return {
    error: lockHeldMessage(result.heldBy.name),
    code: 'PROJECT_LOCKED',
    heldBy: result.heldBy,
    expiresAt: result.expiresAt.toISOString(),
  };
}

export function lockConflictJson(result: AcquireFail) {
  return NextResponse.json(lockConflictBody(result), { status: 409 });
}

/**
 * Both ways a server action can be told the project is not (or is no longer) its to write:
 * `AcquireFail` is a refusal before any work, `LockLost` is a hold that ended while the
 * work was in flight (F-730). Same 409, different code — a lost lock names no holder,
 * because by the time the renewal noticed, anyone could be holding it.
 */
export function lockConflictAction(result: AcquireFail | LockLost) {
  if ('lockLost' in result) {
    return {
      ok: false as const,
      error: result.error,
      status: 409,
      details: { code: 'PROJECT_LOCK_LOST' as const },
    };
  }
  return {
    ok: false as const,
    error: lockHeldMessage(result.heldBy.name),
    status: 409,
    details: {
      code: 'PROJECT_LOCKED' as const,
      heldBy: result.heldBy,
      expiresAt: result.expiresAt.toISOString(),
    },
  };
}
