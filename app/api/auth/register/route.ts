import { NextResponse } from 'next/server';

/**
 * Closed on purpose, in the same voice and with the same status as its sibling
 * `POST /api/auth/signup`.
 *
 * Accounts come from `POST /api/admin/invite`, which creates the User row and hands the
 * admin a temporary password to pass on. Nothing in the product ever creates a *pending*
 * invite for a stranger to claim, so the invite gate this route briefly carried could
 * never be satisfied and it answered 403 to every caller regardless — a control that
 * looks live and cannot fire is worse than no control. It now refuses up front: the body
 * is never read, no password is hashed and no row is looked up, so there is no work whose
 * duration could tell an enumerator which addresses exist or were invited.
 */
export async function POST() {
  return NextResponse.json(
    { error: 'Public signup is disabled. Ask an admin to invite you.' },
    { status: 403 },
  );
}
