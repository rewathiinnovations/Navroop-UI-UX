import { NextResponse } from 'next/server';
import type { AcquireFail } from './lock';

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

export function lockConflictAction(result: AcquireFail) {
  return {
    ok: false as const,
    error: lockHeldMessage(result.heldBy.name),
    status: 409,
    details: {
      code: 'PROJECT_LOCKED',
      heldBy: result.heldBy,
      expiresAt: result.expiresAt.toISOString(),
    },
  };
}
