'use client';

import { notify } from '@/lib/notify';

/**
 * What every admin screen does when its loader comes back 403.
 *
 * The admin layout's `requireAdmin` already handles the normal case, so a 403
 * here means the role was revoked (or the session downgraded) *mid-session* —
 * in another tab, or by another admin. That is precisely when an explanation
 * is owed, and precisely what the old
 * `window.location.replace('/dashboard')` did not give: the page blinked, the
 * user arrived on the dashboard with no message, and a full document
 * navigation threw away whatever client state the screen held (F-419).
 *
 * A router `replace` keeps the toast host mounted, so the message the caller
 * fires survives the navigation. Firing it *before* navigating is the whole
 * point; the shared `key` means six screens racing on the same revocation
 * still show one toast.
 */

export const ADMIN_ACCESS_REVOKED_MESSAGE =
  'Your admin access was removed, so this page is no longer available.';

export const ADMIN_FORBIDDEN_TOAST_KEY = 'admin-access-revoked';

export const ADMIN_FALLBACK_PATH = '/dashboard';

/** The slice of `next/navigation`'s router this needs — and all a test needs to supply. */
export type AdminRouter = { replace: (href: string) => void };

export function handleAdminForbidden(router: AdminRouter) {
  notify.error(ADMIN_ACCESS_REVOKED_MESSAGE, { key: ADMIN_FORBIDDEN_TOAST_KEY });
  router.replace(ADMIN_FALLBACK_PATH);
}
