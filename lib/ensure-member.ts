import { prisma } from "@/lib/db";
import { hashPassword, validateEmail } from "@/lib/password";

export const DEMO_MEMBER_EMAIL = "member@navroop.local";
export const DEMO_MEMBER_PASSWORD = "ChangeMeNow123";

export async function ensureMemberUser() {
  const email = DEMO_MEMBER_EMAIL;
  const password = DEMO_MEMBER_PASSWORD;
  if (!validateEmail(email) || password.length < 8) {
    return { created: false as const };
  }

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    return { created: false as const, user: existing };
  }

  const user = await prisma.user.create({
    data: {
      email,
      name: "Member",
      passwordHash: await hashPassword(password),
      role: "MEMBER",
    },
  });

  return { created: true as const, user };
}
