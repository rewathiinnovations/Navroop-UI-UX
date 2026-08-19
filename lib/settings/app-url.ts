/**
 * The one resolver for this installation's public address.
 *
 * `app.url` sat on /admin/config as an editable field that nothing read: every
 * consumer went to `process.env.APP_URL` directly, so an operator who changed
 * it watched the badge flip to "Set here" while password-reset links, the
 * GitHub App manifest callback and the health checks all kept using the old
 * value until the container was redeployed with a new variable. Anything that
 * needs the public origin at request time resolves it through here.
 *
 * Precedence is the registry's: value saved in the admin UI, then `APP_URL` and
 * its aliases from the environment, then the local-development default.
 */
import { getSetting } from './resolve';

/** Used when neither the database nor the environment names an address. */
export const APP_URL_FALLBACK = 'http://localhost:3000';

export async function appPublicUrl(): Promise<string> {
  const configured = await getSetting('app.url');
  return (configured || APP_URL_FALLBACK).replace(/\/+$/, '');
}
