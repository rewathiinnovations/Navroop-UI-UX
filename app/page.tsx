import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import HomeLanding from '@/components/app/home/HomeLanding';
import type { AuthMode } from '@/components/app/auth/AuthModal';
import { safeNextPath } from '@/lib/auth/public-login';

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ auth?: string; next?: string; reset?: string; forgot?: string }>;
}) {
  // Read before the session check, not after. A visitor who reached the gate on a
  // protected page arrives here as `/?auth=login&next=/templates`, signs in, and
  // `AuthModal` pushes them to that destination — but it also calls
  // `router.refresh()`, which re-runs *this* route, and the redirect below beat the
  // in-flight push every time. So `next` was computed by `proxy.ts` on every gated
  // redirect and then silently discarded, landing everyone on the dashboard.
  // Honouring it here means the destination survives whichever of the two wins.
  const params = await searchParams;
  const nextPath = safeNextPath(params.next);

  const session = await auth();
  if (session?.user?.id) {
    // `next=/` is this route: redirecting to it would bounce straight back in.
    redirect(nextPath && nextPath !== '/' ? nextPath : '/dashboard');
  }

  const authMode: AuthMode | null =
    params.auth === 'login' || params.forgot === '1' || params.reset === '1'
      ? 'login'
      : params.auth === 'signup'
        ? 'signup'
        : null;

  return (
    <HomeLanding
      initialAuth={authMode}
      nextPath={nextPath}
      initialForgot={params.forgot === '1'}
      resetSuccess={params.reset === '1'}
    />
  );
}
