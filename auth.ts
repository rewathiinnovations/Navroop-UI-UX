import NextAuth from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import { PrismaAdapter } from '@auth/prisma-adapter';
import type { Role } from '@/generated/prisma';
import { prisma } from '@/lib/db';
import { isDevQuickLoginEnabled } from '@/lib/dev-quick-login';
import { DEMO_MEMBER_EMAIL, ensureMemberUser } from '@/lib/ensure-member';
import { ensureAdminUser } from '@/lib/ensure-admin';
import { getSeedAdminCredentials, validateEmail, verifyPassword } from '@/lib/password';

export const { handlers, auth, signIn, signOut, unstable_update } = NextAuth({
  adapter: PrismaAdapter(prisma),
  secret: process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET,
  trustHost: true,
  session: {
    strategy: 'jwt',
    maxAge: 14 * 24 * 60 * 60,
  },
  pages: {
    signIn: '/?auth=login',
  },
  providers: [
    Credentials({
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
        devRole: { label: 'Dev role', type: 'text' },
      },
      async authorize(credentials) {
        const devRole = String(credentials?.devRole || '');
        if ((devRole === 'admin' || devRole === 'member') && isDevQuickLoginEnabled()) {
          if (devRole === 'admin') {
            await ensureAdminUser();
            const { email } = getSeedAdminCredentials();
            const user = email ? await prisma.user.findUnique({ where: { email } }) : null;
            if (!user || user.role !== 'ADMIN') return null;
            return {
              id: user.id,
              email: user.email,
              name: user.name,
              role: user.role,
              image: user.avatarUrl,
              avatarUrl: user.avatarUrl,
            };
          }

          await ensureMemberUser();
          const user = await prisma.user.findUnique({ where: { email: DEMO_MEMBER_EMAIL } });
          if (!user) return null;
          return {
            id: user.id,
            email: user.email,
            name: user.name,
            role: user.role,
            image: user.avatarUrl,
            avatarUrl: user.avatarUrl,
          };
        }

        const email = String(credentials?.email || '').trim().toLowerCase();
        const password = String(credentials?.password || '');
        if (!validateEmail(email) || !password) return null;

        const user = await prisma.user.findUnique({ where: { email } });
        if (!user || !(await verifyPassword(password, user.passwordHash))) {
          return null;
        }
        if (!user.isActive) return null;

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          isActive: user.isActive,
          image: user.avatarUrl,
          avatarUrl: user.avatarUrl,
        };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user, trigger, session }) {
      if (user) {
        token.id = user.id;
        token.role = (user as { role: Role }).role;
        token.isActive = (user as { isActive?: boolean }).isActive ?? true;
        token.avatarUrl = (user as { avatarUrl?: string | null }).avatarUrl ?? null;
        if (user.name) token.name = user.name;
      }
      if (trigger === 'update' && session) {
        const next = (session as { user?: { name?: string; avatarUrl?: string | null } }).user ?? session;
        if (typeof next.name === 'string') token.name = next.name;
        if (next && 'avatarUrl' in next) {
          token.avatarUrl = next.avatarUrl ?? null;
          token.picture = next.avatarUrl ?? null;
        }
      }
      if (!user && token.id) {
        try {
          const row = await prisma.user.findUnique({
            where: { id: String(token.id) },
            select: { isActive: true, passwordChangedAt: true },
          });
          if (!row || !row.isActive) {
            delete token.id;
            delete token.sub;
          } else if (
            row.passwordChangedAt &&
            typeof token.iat === 'number' &&
            row.passwordChangedAt.getTime() > token.iat * 1000
          ) {
            delete token.id;
            delete token.sub;
          }
        } catch {
          // Stale Prisma client before a server restart — keep the token.
        }
      }
      return token;
    },
    async session({ session, token }) {
      if (!token.id) {
        return { ...session, user: undefined as unknown as typeof session.user };
      }
      if (session.user) {
        session.user.id = String(token.id || token.sub || '');
        session.user.role = (token.role as Role) ?? 'MEMBER';
        session.user.isActive = (token.isActive as boolean | undefined) ?? true;
        session.user.avatarUrl = (token.avatarUrl as string | null | undefined) ?? null;
        if (typeof token.name === 'string') session.user.name = token.name;
      }
      return session;
    },
  },
});
