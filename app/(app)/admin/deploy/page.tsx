import { redirect } from 'next/navigation';

/**
 * The standalone Coolify token form was superseded by /admin/integrations, but
 * stayed in the navigation and told visitors so in its own body copy. Sending
 * them where the work actually happens is the whole of the fix.
 */
export default function AdminDeployPage() {
  redirect('/admin/integrations');
}
