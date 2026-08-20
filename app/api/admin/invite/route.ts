import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import type { Role } from '@/generated/prisma';
import { writeAudit } from '@/lib/audit/log';
import { issueInvite } from '@/lib/invites/service';

/**
 * Creates a pending invitation and mails the link (F-351).
 *
 * This used to create the User with a temporary password and return that password to the
 * admin, who then relayed it over whatever channel they picked; the `Invite` row was
 * written already accepted, so it recorded history and gated nothing. The mechanics now
 * live in `lib/invites/service.ts` — a single-use sha256-hashed token with an expiry — and
 * no password ever crosses this response.
 */
export async function POST(request: NextRequest) {
  const { user, error, status } = await requireAdmin();
  if (!user) {
    return NextResponse.json({ error }, { status });
  }

  const raw: unknown = await request.json().catch(() => null);
  const body = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const result = await issueInvite({
    email: typeof body.email === 'string' ? body.email : '',
    name: typeof body.name === 'string' ? body.name : undefined,
    role: (body.role === 'ADMIN' ? 'ADMIN' : 'MEMBER') as Role,
    invitedById: user.id,
  });
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, ...(result.details ? { details: result.details } : {}) },
      { status: result.status },
    );
  }

  await writeAudit({
    actorId: user.id,
    actorEmail: user.email,
    action: result.resent ? 'member.invite_resent' : 'member.invite',
    targetType: 'user',
    targetId: result.member.id,
    after: { email: result.member.email, role: result.member.role },
  });

  return NextResponse.json({
    member: { ...result.member, projectCount: 0 },
    invite: {
      expiresAt: result.expiresAt.toISOString(),
      emailed: result.emailed,
      emailError: result.emailError,
      resent: result.resent,
    },
  });
}
