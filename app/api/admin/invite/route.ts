import { randomBytes } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { hashPassword, requireAdmin, validateEmail } from '@/lib/auth';
import type { Role } from '@/generated/prisma';
import { creditDeniedJson } from '@/lib/plans/http';
import { checkLimit } from '@/lib/plans/limits';
import { WORKSPACE_ROW_ID } from '@/lib/storage/usage';
import { writeAudit } from '@/lib/audit/log';

function tempPassword() {
  return `nv-${randomBytes(6).toString('base64url')}`;
}

export async function POST(request: NextRequest) {
  const { user, error, status } = await requireAdmin();
  if (!user) {
    return NextResponse.json({ error }, { status });
  }

  const body = await request.json();
  const email = String(body.email || '').trim().toLowerCase();
  const role = (body.role === 'ADMIN' ? 'ADMIN' : 'MEMBER') as Role;
  const name = String(body.name || '').trim() || email.split('@')[0];

  if (!validateEmail(email)) {
    return NextResponse.json({ error: 'Enter a valid email address' }, { status: 400 });
  }

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    return NextResponse.json({ error: 'A member with that email already exists' }, { status: 409 });
  }

  const memberLimit = await checkLimit(WORKSPACE_ROW_ID, 'members');
  if (!memberLimit.ok) return creditDeniedJson({ ...memberLimit, reason: 'members', message: memberLimit.message || 'Member limit reached' });

  const password = tempPassword();
  const created = await prisma.user.create({
    data: {
      email,
      name,
      role,
      passwordHash: await hashPassword(password),
    },
    select: { id: true, email: true, name: true, role: true, createdAt: true },
  });

  await prisma.invite.create({
    data: {
      email,
      role,
      invitedById: user.id,
      acceptedAt: new Date(),
    },
  });

  await writeAudit({
    actorId: user.id,
    actorEmail: user.email,
    action: 'member.invite',
    targetType: 'user',
    targetId: created.id,
    after: { email: created.email, role: created.role },
  });

  return NextResponse.json({
    member: { ...created, projectCount: 0 },
    temporaryPassword: password,
  });
}
