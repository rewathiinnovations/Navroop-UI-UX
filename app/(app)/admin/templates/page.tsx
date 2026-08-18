import { redirect } from 'next/navigation';
import { requireAdmin } from '@/lib/auth';
import { adminListTemplates } from '@/lib/templates/actions';
import TemplatesAdmin from './TemplatesAdmin';

export default async function AdminTemplatesPage() {
  const { user } = await requireAdmin();
  if (!user) redirect('/dashboard');

  const result = await adminListTemplates({ sort: 'newest' });
  if (!result.ok) redirect('/dashboard');

  return <TemplatesAdmin initialTemplates={result.data.templates} />;
}
